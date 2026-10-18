// Water level, refill pump and alarms for the tank. Plain C++ with no Arduino
// calls, so test/control_test.cpp can run it on a computer.
#pragma once

#include <stdint.h>

namespace watertank {

struct Settings {
  int startLevel = 30;   // start refilling at or below this % full
  int stopLevel = 90;    // stop refilling at or above this % full
  int alarmLevel = 15;   // buzzer and alert below this % full
  bool autoMode = true;
};

enum class Fault : uint8_t {
  None = 0,
  NoRise,   // pump runs but the level does not go up: dry well, closed valve, broken pipe
  MaxRun,   // pump ran longer than any normal refill could take
  Sensor,   // no echo from the ultrasonic sensor several times in a row
};

inline const char* faultName(Fault f) {
  switch (f) {
    case Fault::NoRise: return "norise";
    case Fault::MaxRun: return "maxrun";
    case Fault::Sensor: return "sensor";
    default: return "none";
  }
}

struct Outputs {
  bool pump = false;
  bool alarm = false;   // low water or a fault
  Fault fault = Fault::None;
};

// Safety limits. A 1,000 L tank refills from 30 % to 90 % in about 6 minutes on a
// 100 L/min pump, so 20 minutes of pumping always means something is wrong.
constexpr uint32_t kPumpMaxRunMs = 20UL * 60 * 1000;
constexpr uint32_t kRiseWindowMs = 3UL * 60 * 1000;  // while pumping, the level must rise...
constexpr float kMinRisePct = 2.0f;                   // ...at least this much in each window
constexpr int kSensorFailLimit = 5;                   // missed echoes in a row before a fault

inline bool settingsValid(int start, int stop, int alarm) {
  return alarm >= 5 && alarm < start && start >= 10 && stop <= 98 && stop - start >= 15;
}

// Distance from the sensor (on the lid) to the water, to % full.
// emptyCm: distance when the tank is empty; fullCm: distance at the full mark.
inline float levelPercent(float distanceCm, float emptyCm, float fullCm) {
  if (emptyCm <= fullCm) return 0;
  float pct = (emptyCm - distanceCm) * 100.0f / (emptyCm - fullCm);
  return pct < 0 ? 0 : pct > 100 ? 100 : pct;
}

// Median of the last 5 readings: ultrasonic sensors throw an odd echo off the
// tank wall now and then, and a median ignores it where an average would not.
class Median5 {
 public:
  float add(float v) {
    buf_[next_] = v;
    next_ = (next_ + 1) % 5;
    if (count_ < 5) count_++;
    float s[5];
    for (int i = 0; i < count_; i++) s[i] = buf_[i];
    for (int i = 1; i < count_; i++) {  // insertion sort, 5 items at most
      float x = s[i];
      int j = i - 1;
      while (j >= 0 && s[j] > x) { s[j + 1] = s[j]; j--; }
      s[j + 1] = x;
    }
    return s[count_ / 2];
  }

 private:
  float buf_[5] = {0, 0, 0, 0, 0};
  int next_ = 0;
  int count_ = 0;
};

class Controller {
 public:
  // level: % full; valid: false when the sensor gave no echo this time.
  // A NoRise or MaxRun fault stops the pump until clearFault() (button or dashboard),
  // because restarting a pump that runs dry would burn it out.
  Outputs update(float level, bool valid, const Settings& s, uint32_t now) {
    if (valid) {
      sensorFails_ = 0;
      level_ = level;
      if (fault_ == Fault::Sensor) fault_ = Fault::None;
    } else if (++sensorFails_ >= kSensorFailLimit) {
      fault_ = Fault::Sensor;
    }

    if (s.autoMode && valid) {
      if (level_ <= s.startLevel) wanted_ = true;
      else if (level_ >= s.stopLevel) wanted_ = false;
    }
    // Never overfill, in either mode.
    if (valid && level_ >= s.stopLevel) wanted_ = false;

    bool run = wanted_ && fault_ == Fault::None;
    if (run) {
      if (!pumpOn_) {
        pumpSince_ = now;
        windowStart_ = now;
        windowLevel_ = level_;
      }
      // Elapsed-time checks (now - start) stay correct when millis() wraps.
      if (now - pumpSince_ >= kPumpMaxRunMs) {
        fault_ = Fault::MaxRun;
        run = false;
      } else if (now - windowStart_ >= kRiseWindowMs) {
        if (level_ - windowLevel_ < kMinRisePct) {
          fault_ = Fault::NoRise;
          run = false;
        } else {
          windowStart_ = now;
          windowLevel_ = level_;
        }
      }
    }
    pumpOn_ = run;

    Outputs out;
    out.pump = pumpOn_;
    out.fault = fault_;
    out.alarm = fault_ != Fault::None || (sensorFails_ == 0 && level_ < s.alarmLevel);
    return out;
  }

  void setManualPump(bool on) { wanted_ = on; }
  bool pumpWanted() const { return wanted_; }

  // After fixing the cause (open the valve, prime the pump), clear the fault.
  void clearFault() {
    if (fault_ != Fault::Sensor) fault_ = Fault::None;
    wanted_ = false;
  }

 private:
  bool wanted_ = false;
  bool pumpOn_ = false;
  Fault fault_ = Fault::None;
  float level_ = 0;
  int sensorFails_ = 0;
  uint32_t pumpSince_ = 0;
  uint32_t windowStart_ = 0;
  float windowLevel_ = 0;
};

// Litres used today: every drop in level while the pump is off counts as use.
// Small wobbles (under 0.5 %) are ignored so sensor noise does not add up.
class UsageMeter {
 public:
  // day: local day number (changes at midnight); 0 if the clock is not set yet.
  void update(float level, bool pumpOn, uint32_t day, float tankLitres) {
    if (day != day_) {
      // The first real date after boot (NTP answers a few seconds in) is the same
      // day, so keep what was counted; only a real midnight starts a new day.
      if (day_ != 0) {
        usedLitres_ = 0;
        refills_ = 0;
        ref_ = level;
        hasRef_ = true;
      }
      day_ = day;
    }
    if (pumpOn) {
      if (!wasPumping_) refills_++;
      ref_ = level;
    } else if (!hasRef_ || level > ref_) {
      ref_ = level;
    } else if (ref_ - level >= kNoisePct) {
      usedLitres_ += (ref_ - level) / 100.0f * tankLitres;
      ref_ = level;
    }
    hasRef_ = true;
    wasPumping_ = pumpOn;
  }

  float usedLitres() const { return usedLitres_; }
  int refills() const { return refills_; }

 private:
  static constexpr float kNoisePct = 0.5f;
  uint32_t day_ = 0;
  float usedLitres_ = 0;
  int refills_ = 0;
  float ref_ = 0;
  bool hasRef_ = false;
  bool wasPumping_ = false;
};

}  // namespace watertank
