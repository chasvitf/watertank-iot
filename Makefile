ARDUINO_CLI ?= arduino-cli   # or the one inside Arduino IDE 2 (see README)
FQBN := esp32:esp32:esp32
BUILD := build

.PHONY: test compile wokwi upload

# Host tests for the control logic (no board needed): the C++ firmware code
# and its JavaScript port used by the dashboard simulator
test:
	@mkdir -p $(BUILD)
	c++ -std=c++17 -Wall -Wextra -Werror -o $(BUILD)/control_test test/control_test.cpp
	./$(BUILD)/control_test
	node --test test/control.test.mjs

# Compile the firmware for an ESP32 DevKit
compile:
	$(ARDUINO_CLI) compile --fqbn $(FQBN) --warnings all --output-dir $(BUILD) firmware/watertank

# Regenerate the single-file sketch for wokwi.com
wokwi:
	python3 tools/wokwi_sketch.py

# Flash a real board: make upload PORT=/dev/cu.usbserial-0001
upload: compile
	$(ARDUINO_CLI) upload --fqbn $(FQBN) --port $(PORT) --input-dir $(BUILD)
