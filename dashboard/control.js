// JavaScript port of firmware/watertank/control.h, used by the in-browser
// simulator so it behaves exactly like the board. Keep the two in sync.

export const PUMP_MAX_RUN_MS = 20 * 60 * 1000;
export const RISE_WINDOW_MS = 3 * 60 * 1000;
export const MIN_RISE_PCT = 2;
export const SENSOR_FAIL_LIMIT = 5;

export function settingsValid(start, stop, alarm) {
  return alarm >= 5 && alarm < start && start >= 10 && stop <= 98 && stop - start >= 15;
}

export function levelPercent(distanceCm, emptyCm, fullCm) {
  if (emptyCm <= fullCm) return 0;
  const pct = ((emptyCm - distanceCm) * 100) / (emptyCm - fullCm);
  return Math.min(100, Math.max(0, pct));
}

export class Controller {
  wanted = false;
  pumpOn = false;
  fault = "none";
  level = 0;
  sensorFails = 0;
  pumpSince = 0;
  windowStart = 0;
  windowLevel = 0;

  update(level, valid, s, now) {
    if (valid) {
      this.sensorFails = 0;
      this.level = level;
      if (this.fault === "sensor") this.fault = "none";
    } else if (++this.sensorFails >= SENSOR_FAIL_LIMIT) {
      this.fault = "sensor";
    }
    if (s.autoMode && valid) {
      if (this.level <= s.start) this.wanted = true;
      else if (this.level >= s.stop) this.wanted = false;
    }
    if (valid && this.level >= s.stop) this.wanted = false;

    let run = this.wanted && this.fault === "none";
    if (run) {
      if (!this.pumpOn) {
        this.pumpSince = now;
        this.windowStart = now;
        this.windowLevel = this.level;
      }
      if (now - this.pumpSince >= PUMP_MAX_RUN_MS) {
        this.fault = "maxrun";
        run = false;
      } else if (now - this.windowStart >= RISE_WINDOW_MS) {
        if (this.level - this.windowLevel < MIN_RISE_PCT) {
          this.fault = "norise";
          run = false;
        } else {
          this.windowStart = now;
          this.windowLevel = this.level;
        }
      }
    }
    this.pumpOn = run;
    return {
      pump: this.pumpOn,
      fault: this.fault,
      alarm: this.fault !== "none" || (this.sensorFails === 0 && this.level < s.alarm),
    };
  }

  setManualPump(on) {
    this.wanted = on;
  }

  clearFault() {
    if (this.fault !== "sensor") this.fault = "none";
    this.wanted = false;
  }
}

export class UsageMeter {
  day = 0;
  used = 0;
  refills = 0;
  ref = 0;
  hasRef = false;
  wasPumping = false;

  update(level, pumpOn, day, tankLitres) {
    if (day !== this.day) {
      // The first real date after boot is the same day; only a real midnight resets.
      if (this.day !== 0) {
        this.used = 0;
        this.refills = 0;
        this.ref = level;
        this.hasRef = true;
      }
      this.day = day;
    }
    if (pumpOn) {
      if (!this.wasPumping) this.refills++;
      this.ref = level;
    } else if (!this.hasRef || level > this.ref) {
      this.ref = level;
    } else if (this.ref - level >= 0.5) {
      this.used += ((this.ref - level) / 100) * tankLitres;
      this.ref = level;
    }
    this.hasRef = true;
    this.wasPumping = pumpOn;
  }
}
