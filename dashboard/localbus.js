// A stand-in for the MQTT client inside the page, used by the simulator.
// The simulator used to talk through the public broker; when that broker stopped
// answering subscriptions (2026-10-19), the demo showed nothing. Keeping the
// simulator inside the browser means it always works. Same calls as mqtt.js:
// subscribe, unsubscribe, publish, on("message"), removeListener.
export class LocalBus {
  #handlers = [];

  on(event, fn) {
    if (event === "message") this.#handlers.push(fn);
    return this;
  }

  removeListener(event, fn) {
    this.#handlers = this.#handlers.filter((h) => h !== fn);
    return this;
  }

  subscribe() {}

  unsubscribe() {}

  publish(topic, payload) {
    const text = String(payload);
    // Deliver after the current call returns, like a real broker round trip.
    queueMicrotask(() => this.#handlers.forEach((h) => h(topic, { toString: () => text })));
  }
}
