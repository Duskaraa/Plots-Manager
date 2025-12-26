import { system, world } from "@minecraft/server";

/** @typedef {import("@minecraft/server").ItemUseBeforeEvent} ItemUse */
/** @typedef {import("@minecraft/server").PlayerInventorySlotChangeAfterEvent} PlayerInventoryItemChange */
/** @typedef {import("@minecraft/server").PlayerInteractWithBlockBeforeEvent} PlayerInteractWithBlock */
/** @typedef {import("@minecraft/server").PlayerBreakBlockBeforeEvent} PlayerBreakBlock */
/** @typedef {import("@minecraft/server").PlayerJoinAfterEvent} PlayerJoin */
/** @typedef {import("@minecraft/server").PlayerLeaveBeforeEvent} PlayerLeave */
/** @typedef {import("@minecraft/server").EntitySpawnAfterEvent} EntitySpawn */
/** @typedef {import("@minecraft/server").PlayerSpawnAfterEvent} PlayerSpawn */
/** @typedef {{ data: any, timestamp: number, isWatchdog: boolean }} ShutdownEvent */

/**
 * @typedef {"worldLoad" | "itemUse" | "playerInventoryItemChange" | "playerInteractWithBlock" | "playerBreakBlock" | "playerJoin" | "playerLeave" | "entitySpawn" | "playerSpawn" | "shutdown" | "*"} EventBusEventName
 */

/**
 * @typedef {Object} EventBusPayloads
 * @property {*} worldLoad
 * @property {ItemUse} itemUse
 * @property {PlayerInventoryItemChange} playerInventoryItemChange
 * @property {PlayerInteractWithBlock} playerInteractWithBlock
 * @property {PlayerBreakBlock} playerBreakBlock
 * @property {PlayerJoin} playerJoin
 * @property {PlayerLeave} playerLeave
 * @property {EntitySpawn} entitySpawn
 * @property {PlayerSpawn} playerSpawn
 * @property {ShutdownEvent} shutdown
 * @property {*} *
 */

/** @typedef {{ beforeLoad?: boolean, phase?: "bootstrap" | "runtime" | "before" | "after", anchor?: string }} EventBusModuleOptions */

const BUS_EVENTS = Object.freeze({
  WORLD_LOAD: "worldLoad",
  ITEM_USE: "itemUse",
  INVENTORY_SLOT_CHANGE: "playerInventoryItemChange",
  INTERACT_BLOCK: "playerInteractWithBlock",
  BREAK_BLOCK: "playerBreakBlock",
  PLAYER_JOIN: "playerJoin",
  PLAYER_LEAVE: "playerLeave",
  ENTITY_SPAWN: "entitySpawn",
  PLAYER_SPAWN: "playerSpawn",
  SHUTDOWN: "shutdown",
  ANY: "*",
});

const MODULE_PHASE = Object.freeze({
  BOOTSTRAP: "bootstrap",
  RUNTIME: "runtime",
});

class EventBus {
  static listenersMap = new Map();
  static listenerThreshold = 1000;
  static initialized = false;
  static worldReady = false;
  static moduleQueue = [];
  static importedModules = new Set();
  static bootstrapCompleted = false;
  static runtimeCompleted = false;

  static get listenersSnapshot() {
    const snapshot = new Map();
    for (const [name, handlers] of this.listenersMap.entries()) snapshot.set(name, new Set(handlers));
    return snapshot;
  }

  static get Events() {
    return BUS_EVENTS;
  }

  static on(eventName, handler) {
    this.validateEventName(eventName);
    this.validateHandler(handler);
    const handlers = this.listenersMap.get(eventName) ?? new Set();
    handlers.add(handler);
    this.listenersMap.set(eventName, handlers);
    if (handlers.size > this.listenerThreshold) {
      console.warn(`EventBus: potential listener leak. ${handlers.size} listeners registered for "${eventName}".`);
    }
    return () => this.off(eventName, handler);
  }

  static once(eventName, handler) {
    this.validateEventName(eventName);
    this.validateHandler(handler);
    let completed = false;
    const wrapper = (payload, invokedEvent) => {
      if (completed) return;
      completed = true;
      try {
        handler(payload, invokedEvent);
      } finally {
        this.off(eventName, wrapper);
      }
    };
    return this.on(eventName, wrapper);
  }

  static off(eventName = null, handler) {
    if (eventName === null) {
      this.listenersMap.clear();
      return;
    }
    this.validateEventName(eventName);
    const handlers = this.listenersMap.get(eventName);
    if (!handlers) return;
    if (handler === undefined) {
      this.listenersMap.delete(eventName);
      return;
    }
    this.validateHandler(handler);
    handlers.delete(handler);
    if (handlers.size === 0) this.listenersMap.delete(eventName);
  }

  static emit(eventName, payload) {
    this.validateEventName(eventName);
    const specificHandlers = this.listenersMap.get(eventName);
    const wildcardHandlers = this.listenersMap.get(BUS_EVENTS.ANY);
    if (!specificHandlers && !wildcardHandlers) return;
    const handlers = new Set();
    if (specificHandlers) specificHandlers.forEach((fn) => handlers.add(fn));
    if (wildcardHandlers) wildcardHandlers.forEach((fn) => handlers.add(fn));
    for (const fn of handlers) {
      try {
        const shouldSendEventName = wildcardHandlers?.has(fn) && (!specificHandlers || !specificHandlers.has(fn));
        shouldSendEventName ? fn(payload, eventName) : fn(payload);
      } catch (error) {
        try {
          console.error(`EventBus handler failure for "${eventName}"`, error);
        } catch { }
      }
    }
  }

  static async emitAsync(eventName, payload) {
    this.validateEventName(eventName);
    const specificHandlers = this.listenersMap.get(eventName);
    const wildcardHandlers = this.listenersMap.get(BUS_EVENTS.ANY);
    if (!specificHandlers && !wildcardHandlers) return [];
    const handlers = new Set();
    if (specificHandlers) specificHandlers.forEach((fn) => handlers.add(fn));
    if (wildcardHandlers) wildcardHandlers.forEach((fn) => handlers.add(fn));
    const tasks = Array.from(handlers, (fn) => {
      const shouldSendEventName = wildcardHandlers?.has(fn) && (!specificHandlers || !specificHandlers.has(fn));
      try {
        const result = shouldSendEventName ? fn(payload, eventName) : fn(payload);
        return Promise.resolve(result);
      } catch (error) {
        return Promise.reject(error);
      }
    });
    return Promise.allSettled(tasks);
  }

  static listeners(eventName) {
    this.validateEventName(eventName);
    const handlers = this.listenersMap.get(eventName);
    return handlers ? Array.from(handlers) : [];
  }

  static listenerCount(eventName) {
    this.validateEventName(eventName);
    const handlers = this.listenersMap.get(eventName);
    return handlers ? handlers.size : 0;
  }

  static eventNames() {
    return Array.from(this.listenersMap.keys());
  }

  static clearListeners(eventName) {
    this.off(eventName ?? null);
  }

  static registerModule(specifier, options = {}) {
    this.validateModuleSpecifier(specifier);
    const phase = this.normalizePhase(options.phase, options.beforeLoad);
    const resolvedSpecifier = this.resolveModuleSpecifier(specifier, options.anchor);
    const entry = { specifier: resolvedSpecifier, phase };
    this.moduleQueue.push(entry);
    const bootstrapReady = phase === MODULE_PHASE.BOOTSTRAP && this.bootstrapCompleted;
    const runtimeReady = phase === MODULE_PHASE.RUNTIME && this.runtimeCompleted;
    if (bootstrapReady || runtimeReady) void this.importModule(resolvedSpecifier);
    return () => {
      const idx = this.moduleQueue.indexOf(entry);
      if (idx >= 0) this.moduleQueue.splice(idx, 1);
    };
  }

  static initialize() {
    if (this.initialized) return;
    this.initialized = true;
    this.setupWatchdogGuard();
    void this.importPhase(MODULE_PHASE.BOOTSTRAP);
    world.afterEvents.worldLoad.subscribe((event) => {
      if (this.worldReady) return;
      this.worldReady = true;
      try {
        this.attachMinecraftEvents();
        this.emit(BUS_EVENTS.WORLD_LOAD, event);
        void this.importPhase(MODULE_PHASE.RUNTIME);
      } catch (error) {
        console.error("EventBus initialization failure during world load.", error);
      }
    });
  }

  static setupWatchdogGuard() {
    try {
      const watchdog = system?.beforeEvents?.watchdogTerminate;
      if (watchdog && typeof watchdog.subscribe === "function") {
        watchdog.subscribe((event) => {
          try {
            event.cancel = true;
          } catch { }
          try {
            console.warn(`[Watchdog] Blocked termination: ${event?.terminateReason ?? "unknown"}.`);
          } catch { }
          try {
            this.emit(BUS_EVENTS.SHUTDOWN, { data: event, timestamp: Date.now(), isWatchdog: true });
          } catch (error) {
            console.error("Error emitting shutdown from watchdog.", error);
          }
        });
      }
    } catch (error) {
      console.log("Watchdog setup non-fatal:", error);
    }
  }

  static attachMinecraftEvents() {
    const bindings = [
      { event: BUS_EVENTS.ITEM_USE, source: world.beforeEvents?.itemUse },
      { event: BUS_EVENTS.INVENTORY_SLOT_CHANGE, source: world.afterEvents?.playerInventoryItemChange },
      { event: BUS_EVENTS.INTERACT_BLOCK, source: world.beforeEvents?.playerInteractWithBlock },
      { event: BUS_EVENTS.BREAK_BLOCK, source: world.beforeEvents?.playerBreakBlock },
      { event: BUS_EVENTS.PLAYER_JOIN, source: world.afterEvents?.playerJoin },
      { event: BUS_EVENTS.PLAYER_LEAVE, source: world.beforeEvents?.playerLeave },
      { event: BUS_EVENTS.ENTITY_SPAWN, source: world.afterEvents?.entitySpawn },
      { event: BUS_EVENTS.PLAYER_SPAWN, source: world.afterEvents?.playerSpawn },
    ];
    bindings.forEach(({ event, source }) => {
      if (!source || typeof source.subscribe !== "function") return;
      source.subscribe((payload) => this.emit(event, payload));
    });
  }

  static async importPhase(phase) {
    const pending = this.moduleQueue.filter((entry) => entry.phase === phase);
    if (phase === MODULE_PHASE.BOOTSTRAP) this.bootstrapCompleted = true;
    if (phase === MODULE_PHASE.RUNTIME) this.runtimeCompleted = true;
    if (pending.length === 0) return;
    const results = await Promise.allSettled(pending.map((entry) => this.importModule(entry.specifier)));
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length > 0) {
      console.error(`EventBus: ${failures.length} module import(s) failed during ${phase} phase.`);
    }
  }

  static async importModule(specifier) {
    if (this.importedModules.has(specifier)) return;
    this.importedModules.add(specifier);
    try {
      await import(specifier);
    } catch (error) {
      console.error(`EventBus: failed to import module '${specifier}'.`, error);
    }
  }

  static validateEventName(eventName) {
    if (typeof eventName !== "string") throw new TypeError("Event name must be a string");
  }

  static validateHandler(handler) {
    if (typeof handler !== "function") throw new TypeError("Handler must be a function");
  }

  static validateModuleSpecifier(specifier) {
    if (typeof specifier !== "string" || specifier.trim() === "") {
      throw new TypeError("Module specifier must be a non-empty string");
    }
  }

  static resolveModuleSpecifier(specifier, anchor) {
    const trimmed = specifier.trim();
    const isRelative = trimmed.startsWith("./") || trimmed.startsWith("../");
    const isAbsolute = /^([a-zA-Z]+:|\/\/|\/)/.test(trimmed);
    if (isAbsolute) return trimmed;
    if (isRelative) {
      if (!anchor) throw new Error("Relative module specifiers require an anchor (pass { anchor: import.meta.url }).");
      return new URL(trimmed, anchor).toString();
    }
    return trimmed;
  }

  static normalizePhase(phase, legacyBeforeLoad) {
    if (phase === MODULE_PHASE.BOOTSTRAP || phase === "before") return MODULE_PHASE.BOOTSTRAP;
    if (phase === MODULE_PHASE.RUNTIME || phase === "after") return MODULE_PHASE.RUNTIME;
    return legacyBeforeLoad ? MODULE_PHASE.BOOTSTRAP : MODULE_PHASE.RUNTIME;
  }
}

export default EventBus;
EventBus.initialize();
