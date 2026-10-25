import Foundation
import Capacitor
import HealthKit
import CoreLocation

/// 건강 앱(HealthKit)의 러닝 기록을 웹 화면에 넘겨 주는 플러그인.
/// JS: Capacitor.Plugins.RunlogHealth.listWorkouts({limit}) / getWorkout({id})
@objc(RunlogHealthPlugin)
public class RunlogHealthPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "RunlogHealthPlugin"
    public let jsName = "RunlogHealth"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "isAvailable", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listWorkouts", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getWorkout", returnType: CAPPluginReturnPromise),
    ]

    private let store = HKHealthStore()
    private let hrType = HKObjectType.quantityType(forIdentifier: .heartRate)!
    private let stepType = HKObjectType.quantityType(forIdentifier: .stepCount)!
    private let distType = HKObjectType.quantityType(forIdentifier: .distanceWalkingRunning)!
    private let bpm = HKUnit.count().unitDivided(by: .minute())

    @objc func isAvailable(_ call: CAPPluginCall) {
        call.resolve(["available": HKHealthStore.isHealthDataAvailable()])
    }

    /// 읽기 권한 요청 — 이미 답한 적이 있으면 바로 끝난다.
    /// (읽기 권한은 개인정보 보호를 위해 허용 여부를 알려 주지 않으므로, 거부되면 그냥 빈 목록이 온다)
    private func authorize(_ done: @escaping (Error?) -> Void) {
        guard HKHealthStore.isHealthDataAvailable() else {
            done(NSError(domain: "RunlogHealth", code: 1, userInfo: [NSLocalizedDescriptionKey: "이 기기에서는 건강 앱을 쓸 수 없어요"]))
            return
        }
        let read: Set<HKObjectType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute(), hrType, stepType, distType]
        store.requestAuthorization(toShare: nil, read: read) { _, err in done(err) }
    }

    @objc func listWorkouts(_ call: CAPPluginCall) {
        let limit = call.getInt("limit") ?? 30
        authorize { err in
            if let err = err { call.reject(err.localizedDescription); return }
            let pred = HKQuery.predicateForWorkouts(with: .running)
            let sort = NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: false)
            let q = HKSampleQuery(sampleType: .workoutType(), predicate: pred, limit: limit, sortDescriptors: [sort]) { _, samples, err in
                if let err = err { call.reject(err.localizedDescription); return }
                let workouts = samples as? [HKWorkout] ?? []
                guard let oldest = workouts.last?.startDate else { call.resolve(["workouts": []]); return }
                // 경로가 실제로 있는지 — 운동마다 묻지 않고 기간 안의 경로를 한 번에 받아 시간으로 맞춘다
                // (야외 러닝이어도 기록한 앱이 경로를 건강 앱에 넘기지 않으면 없다)
                let range = HKQuery.predicateForSamples(withStart: oldest.addingTimeInterval(-60), end: Date(), options: [])
                let rq = HKSampleQuery(sampleType: HKSeriesType.workoutRoute(), predicate: range, limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, routes, _ in
                    let starts = (routes ?? []).map { $0.startDate }
                    let list: [[String: Any]] = workouts.map { w in
                        var o = self.summary(w)
                        o["hasRoute"] = starts.contains { $0 >= w.startDate.addingTimeInterval(-60) && $0 <= w.endDate }
                        return o
                    }
                    call.resolve(["workouts": list])
                }
                self.store.execute(rq)
            }
            self.store.execute(q)
        }
    }

    private func summary(_ w: HKWorkout) -> [String: Any] {
        let indoor = (w.metadata?[HKMetadataKeyIndoorWorkout] as? NSNumber)?.boolValue ?? false
        var out: [String: Any] = [
            "id": w.uuid.uuidString,
            "name": indoor ? "실내 달리기" : "야외 달리기",
            "start": w.startDate.timeIntervalSince1970 * 1000,
            "duration": w.duration,
            "indoor": indoor,
            "source": w.sourceRevision.source.name,
            "bundle": w.sourceRevision.source.bundleIdentifier,
        ]
        var meters: Double?
        if #available(iOS 16.0, *) {
            meters = w.statistics(for: distType)?.sumQuantity()?.doubleValue(for: .meter())
            if let hr = w.statistics(for: hrType)?.averageQuantity()?.doubleValue(for: bpm) { out["avgHr"] = hr }
        }
        if meters == nil { meters = w.totalDistance?.doubleValue(for: .meter()) }
        if let m = meters { out["distance"] = m }
        if let up = w.metadata?[HKMetadataKeyElevationAscended] as? HKQuantity { out["elevGain"] = up.doubleValue(for: .meter()) }
        return out
    }

    @objc func getWorkout(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), let uuid = UUID(uuidString: id) else { call.reject("활동 id 가 없어요"); return }
        authorize { err in
            if let err = err { call.reject(err.localizedDescription); return }
            let q = HKSampleQuery(sampleType: .workoutType(), predicate: HKQuery.predicateForObject(with: uuid), limit: 1, sortDescriptors: nil) { _, samples, _ in
                guard let w = samples?.first as? HKWorkout else { call.reject("활동을 찾지 못했어요"); return }
                self.details(w) { call.resolve($0) }
            }
            self.store.execute(q)
        }
    }

    /// 경로 [[lat, lon, t(ms), 고도]] · 심박 [[t, bpm]] · 걸음 [[t0, t1, 걸음 수]]
    private func details(_ w: HKWorkout, _ done: @escaping ([String: Any]) -> Void) {
        let group = DispatchGroup()
        let lock = NSLock()
        var pts: [[Double]] = [], hr: [[Double]] = [], steps: [[Double]] = []
        let ms = { (d: Date) in d.timeIntervalSince1970 * 1000 }

        // 1) GPS 경로 (경로 샘플마다 위치를 나눠 받는다)
        group.enter()
        let routeQ = HKSampleQuery(sampleType: HKSeriesType.workoutRoute(), predicate: HKQuery.predicateForObjects(from: w), limit: HKObjectQueryNoLimit, sortDescriptors: nil) { _, samples, _ in
            let routes = samples as? [HKWorkoutRoute] ?? []
            for r in routes {
                group.enter()
                let lq = HKWorkoutRouteQuery(route: r) { _, locs, finished, err in
                    if let locs = locs {
                        lock.lock()
                        pts += locs.filter { $0.horizontalAccuracy >= 0 && $0.horizontalAccuracy < 50 }
                            .map { [$0.coordinate.latitude, $0.coordinate.longitude, ms($0.timestamp), $0.altitude] }
                        lock.unlock()
                    }
                    if finished || err != nil { group.leave() }
                }
                self.store.execute(lq)
            }
            group.leave()
        }
        store.execute(routeQ)

        // 2) 운동 시간 동안의 심박·걸음 수
        let range = HKQuery.predicateForSamples(withStart: w.startDate, end: w.endDate, options: [])
        let byTime = [NSSortDescriptor(key: HKSampleSortIdentifierStartDate, ascending: true)]
        group.enter()
        store.execute(HKSampleQuery(sampleType: hrType, predicate: range, limit: HKObjectQueryNoLimit, sortDescriptors: byTime) { _, s, _ in
            let v = (s as? [HKQuantitySample] ?? []).map { [ms($0.startDate), $0.quantity.doubleValue(for: self.bpm)] }
            lock.lock(); hr = v; lock.unlock()
            group.leave()
        })
        group.enter()
        store.execute(HKSampleQuery(sampleType: stepType, predicate: range, limit: HKObjectQueryNoLimit, sortDescriptors: byTime) { _, s, _ in
            let v = (s as? [HKQuantitySample] ?? []).map { [ms($0.startDate), ms($0.endDate), $0.quantity.doubleValue(for: .count())] }
            lock.lock(); steps = v; lock.unlock()
            group.leave()
        })

        group.notify(queue: .global()) {
            pts.sort { $0[2] < $1[2] }
            done(["pts": pts, "hr": hr, "steps": steps])
        }
    }

    #if DEBUG
    /// 개발용: 시뮬레이터 건강 앱에 가상의 러닝 기록을 넣는다
    /// (남산 둘레 가상 루프 + 실내 러닝 + 경로 없이 저장된 야외 러닝 — 경로를 넘기지 않는 앱의 기록 흉내).
    /// 실행 인자 `-seedHealthDemo YES` 로 앱을 켜면 한 번 실행된다. 실제 사용자 데이터가 아니다.
    func seedDemo() {
        let share: Set<HKSampleType> = [.workoutType(), HKSeriesType.workoutRoute(), hrType, stepType, distType]
        let read: Set<HKObjectType> = [HKObjectType.workoutType(), HKSeriesType.workoutRoute(), hrType, stepType, distType]
        store.requestAuthorization(toShare: share, read: read) { ok, err in
            guard ok else { print("seed: 권한 없음 \(String(describing: err))"); return }
            let cal = Calendar.current
            let morning = cal.date(bySettingHour: 6, minute: 30, second: 0, of: Date())!.addingTimeInterval(-86400)
            self.seedRun(start: morning, outdoor: true)
            self.seedRun(start: morning.addingTimeInterval(-2 * 86400), outdoor: false)
            self.seedRun(start: morning.addingTimeInterval(-4 * 86400), outdoor: true, route: false)
        }
    }

    private func seedRun(start: Date, outdoor: Bool, route: Bool = true) {
        let lat0 = 37.5512, lon0 = 126.9882
        let mlat = 111_320.0, mlon = 111_320.0 * cos(lat0 * .pi / 180)
        // 점 · 누적 거리 · 시각
        var locs: [CLLocation] = []
        var prev: (Double, Double)?
        var dist = 0.0, t = 0.0
        let n = 2400
        var raw: [(Double, Double)] = []
        for i in 0...n {
            let a = Double(i) / Double(n) * 2 * .pi
            let r = 1.0 + 0.10 * sin(3 * a + 0.5) + 0.05 * sin(7 * a)
            raw.append((lat0 + 820 * r * sin(a) / mlat, lon0 + 1050 * r * cos(a) / mlon))
        }
        var total = 0.0
        for i in 1..<raw.count { total += hypot((raw[i].0 - raw[i - 1].0) * mlat, (raw[i].1 - raw[i - 1].1) * mlon) }
        var marks: [(t: Double, d: Double)] = []
        for (la, lo) in raw {
            if let p = prev { dist += hypot((la - p.0) * mlat, (lo - p.1) * mlon) }
            let f = dist / total
            let pace = 330 + 25 * sin(2 * .pi * f * 1.3) + 18 * sin(10 * f)   // 초/km
            if prev != nil { t += (dist - (marks.last?.d ?? 0)) / 1000 * pace }
            marks.append((t, dist))
            let ele = 60 + 70 * pow(sin(.pi * f), 2) + 12 * sin(6 * .pi * f)
            locs.append(CLLocation(coordinate: CLLocationCoordinate2D(latitude: la, longitude: lo), altitude: ele,
                                   horizontalAccuracy: 5, verticalAccuracy: 3, timestamp: start.addingTimeInterval(t)))
            prev = (la, lo)
        }
        let end = start.addingTimeInterval(t)
        // 심박(5초마다) · 걸음(1분마다) · 거리(1분마다)
        var samples: [HKSample] = []
        var s = 0.0
        while s < t {
            let f = s / t
            let hr = 142 + 16 * f + 6 * sin(8 * .pi * f)
            samples.append(HKQuantitySample(type: hrType, quantity: HKQuantity(unit: bpm, doubleValue: hr),
                                            start: start.addingTimeInterval(s), end: start.addingTimeInterval(s)))
            s += 5
        }
        var m = 0.0
        while m < t {
            let m1 = min(t, m + 60), f = m / t
            let spm = 176 + 4 * sin(5 * .pi * f)
            samples.append(HKQuantitySample(type: stepType, quantity: HKQuantity(unit: .count(), doubleValue: spm * (m1 - m) / 60),
                                            start: start.addingTimeInterval(m), end: start.addingTimeInterval(m1)))
            let d0 = marks.last { $0.t <= m }?.d ?? 0, d1 = marks.last { $0.t <= m1 }?.d ?? total
            samples.append(HKQuantitySample(type: distType, quantity: HKQuantity(unit: .meter(), doubleValue: max(0, d1 - d0)),
                                            start: start.addingTimeInterval(m), end: start.addingTimeInterval(m1)))
            m = m1
        }
        let cfg = HKWorkoutConfiguration()
        cfg.activityType = .running
        cfg.locationType = outdoor ? .outdoor : .indoor
        let builder = HKWorkoutBuilder(healthStore: store, configuration: cfg, device: .local())
        builder.beginCollection(withStart: start) { _, _ in
            builder.add(samples) { _, _ in
                var meta: [String: Any] = [HKMetadataKeyIndoorWorkout: !outdoor]
                if outdoor { meta[HKMetadataKeyElevationAscended] = HKQuantity(unit: .meter(), doubleValue: 85) }
                builder.addMetadata(meta) { _, _ in
                    builder.endCollection(withEnd: end) { _, _ in
                        builder.finishWorkout { workout, err in
                            guard let workout = workout else { print("seed: 실패 \(String(describing: err))"); return }
                            guard outdoor && route else { print("seed: 경로 없는 러닝 저장"); return }
                            let rb = HKWorkoutRouteBuilder(healthStore: self.store, device: .local())
                            rb.insertRouteData(locs) { _, _ in
                                rb.finishRoute(with: workout, metadata: nil) { _, err in print("seed: 야외 러닝 + 경로 저장 \(String(describing: err))") }
                            }
                        }
                    }
                }
            }
        }
    }
    #endif
}
