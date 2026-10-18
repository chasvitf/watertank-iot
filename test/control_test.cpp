// Host tests for firmware/watertank/control.h: c++ -std=c++17 test/control_test.cpp && ./a.out
#include <cmath>
#include <cstdio>
#include <cstdlib>

#include "../firmware/watertank/control.h"

using namespace watertank;

static int failures = 0;
#define CHECK(cond)                                                   \
  do {                                                                \
    if (!(cond)) {                                                    \
      std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond);     \
      failures++;                                                     \
    }                                                                 \
  } while (0)

static const uint32_t S = 1000, M = 60 * 1000;

static void levelFromDistance() {
  CHECK(levelPercent(120, 120, 20) == 0);    // empty
  CHECK(levelPercent(20, 120, 20) == 100);   // full mark
  CHECK(levelPercent(70, 120, 20) == 50);
  CHECK(levelPercent(10, 120, 20) == 100);   // above the full mark: clamped
  CHECK(levelPercent(150, 120, 20) == 0);    // odd far echo: clamped
}

static void medianIgnoresOneBadEcho() {
  Median5 m;
  m.add(50); m.add(51); m.add(50); m.add(400);  // 400 cm = echo off the wall
  CHECK(m.add(51) == 51);
}

static void refillsBetweenStartAndStop() {
  Controller c; Settings s; uint32_t t = 0;
  CHECK(!c.update(50, true, s, t).pump);           // between thresholds, idle: stays off
  CHECK(c.update(30, true, s, t += S).pump);       // at the start level: on
  CHECK(c.update(60, true, s, t += S).pump);       // still filling (hysteresis)
  CHECK(!c.update(90, true, s, t += S).pump);      // at the stop level: off
  CHECK(!c.update(60, true, s, t += S).pump);      // drains a bit: stays off until 30 %
}

static void stopsWhenLevelDoesNotRise() {
  Controller c; Settings s; uint32_t t = 0;
  Outputs o = c.update(25, true, s, t);
  CHECK(o.pump);
  for (int i = 0; i < 180; i++) o = c.update(25.5f, true, s, t += S);   // 3 minutes, +0.5 % only
  CHECK(!o.pump);
  CHECK(o.fault == Fault::NoRise);
  CHECK(o.alarm);
  o = c.update(25, true, s, t += 10 * M);
  CHECK(!o.pump);                                    // latched: no restart on its own
  c.clearFault();
  CHECK(c.update(25, true, s, t += S).pump);         // cleared, level still low: refills again
}

static void normalRefillDoesNotTrip() {
  Controller c; Settings s; uint32_t t = 0;
  float level = 28;
  Outputs o = c.update(level, true, s, t);
  while (o.pump) {
    level += 0.17f;                                  // about 10 % per minute
    o = c.update(level, true, s, t += S);
  }
  CHECK(o.fault == Fault::None);
  CHECK(level >= 90);
}

static void maxRunTime() {
  Controller c; Settings s; uint32_t t = 0;
  float level = 10;
  Outputs o = c.update(level, true, s, t);
  for (int i = 0; i < 21 * 60 && o.pump; i++) {
    level += 0.012f;                                 // rising just fast enough for the window check
    o = c.update(level, true, s, t += S);
  }
  CHECK(o.fault == Fault::MaxRun);
  CHECK(!o.pump);
}

static void sensorFailureStopsPump() {
  Controller c; Settings s; uint32_t t = 0;
  CHECK(c.update(20, true, s, t).pump);
  Outputs o;
  for (int i = 0; i < 4; i++) o = c.update(0, false, s, t += S);
  CHECK(o.pump);                                     // a few missed echoes are tolerated
  o = c.update(0, false, s, t += S);
  CHECK(o.fault == Fault::Sensor && !o.pump && o.alarm);
  o = c.update(21, true, s, t += S);
  CHECK(o.fault == Fault::None && o.pump);           // sensor back: carries on by itself
}

static void manualModeStillProtects() {
  Controller c; Settings s; s.autoMode = false; uint32_t t = 0;
  CHECK(!c.update(50, true, s, t).pump);
  c.setManualPump(true);
  CHECK(c.update(50, true, s, t += S).pump);
  CHECK(!c.update(90, true, s, t += S).pump);        // never overfills, even by hand
}

static void lowLevelAlarm() {
  Controller c; Settings s; uint32_t t = 0;
  CHECK(c.update(10, true, s, t).alarm);
  CHECK(!c.update(40, true, s, t += S).alarm);
}

static void timerWrap() {
  Controller c; Settings s;
  uint32_t t = 0xFFFFFFFFu - 30 * S;                 // millis() about to wrap after 49.7 days
  float level = 25;
  Outputs o = c.update(level, true, s, t);
  for (int i = 0; i < 120; i++) {
    level += 0.17f;
    o = c.update(level, true, s, t += S);
  }
  CHECK(o.fault == Fault::None);                     // no false fault across the wrap
}

static void usageCountsDrops() {
  UsageMeter u;
  u.update(80, false, 1, 1000);
  u.update(79.8f, false, 1, 1000);                   // noise: ignored
  u.update(75, false, 1, 1000);                      // 5 % of 1,000 L used
  CHECK(std::fabs(u.usedLitres() - 50) < 0.01f);
  u.update(76, true, 1, 1000);                       // refill starts
  u.update(90, true, 1, 1000);
  u.update(90, false, 1, 1000);
  CHECK(u.refills() == 1);
  CHECK(std::fabs(u.usedLitres() - 50) < 0.01f);     // filling is not use
  u.update(88, false, 2, 1000);                      // new day
  CHECK(u.usedLitres() == 0 && u.refills() == 0);
}

static void settingsChecks() {
  CHECK(settingsValid(30, 90, 15));
  CHECK(!settingsValid(30, 40, 15));                 // stop too close to start: pump would cycle
  CHECK(!settingsValid(30, 90, 30));                 // alarm must be below start
  CHECK(!settingsValid(30, 99, 15));
}

int main() {
  levelFromDistance();
  medianIgnoresOneBadEcho();
  refillsBetweenStartAndStop();
  stopsWhenLevelDoesNotRise();
  normalRefillDoesNotTrip();
  maxRunTime();
  sensorFailureStopsPump();
  manualModeStillProtects();
  lowLevelAlarm();
  timerWrap();
  usageCountsDrops();
  settingsChecks();
  if (failures) {
    std::printf("%d check(s) failed\n", failures);
    return EXIT_FAILURE;
  }
  std::printf("all control tests passed\n");
  return EXIT_SUCCESS;
}
