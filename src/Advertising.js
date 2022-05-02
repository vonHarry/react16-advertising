import getAdUnits from './utils/getAdUnits';
import logMessage from './utils/logMessage';

const defaultLazyLoadConfig = {
  marginPercent: 100,
  mobileScaling: 1,
  rootMargin: '20% 0% 100% 0%'
};
const requestManager = {
  FAILSAFE_TIMEOUT: 4500,
  queues: {},
  newQueue: (data) => {
    const now = Date.now();
    const id = `${now}-${Math.round(Math.random()*100000)}`;
    requestManager.queues[id] = {
      failsafeTimeout: window.setTimeout(() => {
        logMessage('requestManager failsave triggered', id, data);
        requestManager.sendAdserverRequest(id, data.refreshableSlots);
      }, requestManager.FAILSAFE_TIMEOUT),
      adserverRequestSent: false,
      apsDone: true,
      prebidDone: true,
      data: { ...data, started: now }
    };
    return id;
  },
  biddersBack: (queueId, refreshableSlots, type) => {
    const queue = requestManager.queues[queueId];
    logMessage('requestManager biddersBack', queueId, queue, refreshableSlots, type);
    // when both APS and Prebid bids have returned, initiate ad request
    if (queue.apsDone && queue.prebidDone) {
      clearTimeout(queue.failsafeTimeout);
      requestManager.sendAdserverRequest(queueId, refreshableSlots);
    }
  },
  sendAdserverRequest: (queueId, refreshableSlots) => {
    const queue = requestManager.queues[queueId];
    if (queue.adserverRequestSent === true) {
      return;
    }
    queue.adserverRequestSent = true;
    googletag.cmd.push(() => {
      logMessage('requestManager sendAdserverRequest refresh', queueId);
      if (refreshableSlots) {
        window.googletag.pubads().refresh(refreshableSlots);
      } else {
        window.googletag.pubads().refresh()
      }
    });
  }
};

export default class Advertising {
  constructor(config, plugins = [], onError = () => {}) {
    this.config = config;
    this.slots = {};
    this.outOfPageSlots = {};
    this.plugins = plugins;
    this.onError = onError;
    this.gptSizeMappings = {};
    this.customEventCallbacks = {};
    this.customEventHandlers = {};
    this.queue = [];
    this.setDefaultConfig();
  }

  // ---------- PUBLIC METHODS ----------

  async setup() {
    this.isPrebidUsed =
      typeof this.config.usePrebid === 'undefined'
        ? typeof window.pbjs !== 'undefined'
        : this.config.usePrebid;
    this.isApsTagUsed =
      typeof this.config.useApsTag === 'undefined'
        ? typeof window.apstag !== 'undefined'
        : this.config.useApsTag;
    logMessage('setup', this.isPrebidUsed, this.isApsTagUsed);

    this.executePlugins('setup');
    const { queue, isPrebidUsed, config } = this;
    this.setupCustomEvents();
    const setUpQueueItems = [
      Advertising.queueForGPT(this.setupGpt.bind(this), this.onError),
    ];
    if (isPrebidUsed) {
      setUpQueueItems.push(
        Advertising.queueForPrebid(this.setupPrebid.bind(this), this.onError)
      );
    }
    await Promise.all(setUpQueueItems);
    if (queue.length === 0) {
      return;
    }
    for (let i = 0; i < queue.length; i++) {
      const { id, customEventHandlers } = queue[i];
      Object.keys(customEventHandlers).forEach((customEventId) => {
        if (!this.customEventCallbacks[customEventId]) {
          this.customEventCallbacks[customEventId] = {};
        }
        return (this.customEventCallbacks[customEventId][id] =
          customEventHandlers[customEventId]);
      });
    }

    this.queueBids();
  }

  async teardown() {
    this.teardownCustomEvents();
    const teardownQueueItems = [
      Advertising.queueForGPT(this.teardownGpt.bind(this), this.onError),
    ];
    if (this.isPrebidUsed) {
      teardownQueueItems.push(
        Advertising.queueForPrebid(this.teardownPrebid.bind(this), this.onError)
      );
    }
    await Promise.all(teardownQueueItems);
    this.slots = {};
    this.gptSizeMappings = {};
    this.queue = [];
  }

  activate(id, customEventHandlers = {}) {
    const { slots, config } = this;
    if (Object.values(slots).length === 0) {
      this.queue.push({ id, customEventHandlers });
      return;
    }
    Object.keys(customEventHandlers).forEach((customEventId) => {
      if (!this.customEventCallbacks[customEventId]) {
        this.customEventCallbacks[customEventId] = {};
      }
      return (this.customEventCallbacks[customEventId][id] =
        customEventHandlers[customEventId]);
    });

    this.queueBids(id);
  }

  queueBids(singleId) {
    const { slots, outOfPageSlots, queue, config, isPrebidUsed, isApsTagUsed } = this;
    let prebidSlots, apsSlots, refreshableSlots = [];

    if (singleId) {
      refreshableSlots = slots[singleId] || outOfPageSlots[singleId];
      prebidSlots = [singleId];
      if (config.amazonPublisherServicesSlots) {
        apsSlots = config.amazonPublisherServicesSlots?.find(slot => slot.slotID === singleId) || [];
      }
    } else {
      refreshableSlots = null;
      prebidSlots = queue.map(({ id }) => id);
      if (config.amazonPublisherServicesSlots) {
        apsSlots = config.amazonPublisherServicesSlots;
      }
    }

    if (isPrebidUsed || isApsTagUsed) {
      const queueId = requestManager.newQueue({
        singleId,
        refreshableSlots,
        prebidSlots,
        apsSlots
      });
      const requestQueue = requestManager.queues[queueId];

      if (isPrebidUsed) {
        requestQueue.prebidDone = false;
        logMessage('queueBids prebid prebidSlots', prebidSlots);
        Advertising.queueForPrebid(
          () =>
            window.pbjs.requestBids({
              adUnitCodes: prebidSlots,
              bidsBackHandler: (bids) => {
                window.pbjs.setTargetingForGPTAsync(prebidSlots);
                Advertising.queueForGPT(
                  () => {
                    const returnedBidsIds = Object.keys(bids);
                    logMessage('queueBids prebid queueForGPT bids done', returnedBidsIds, Date.now() - requestQueue.data.started);
                    requestQueue.prebidDone = true; // signals that Prebid request has completed
                    requestManager.biddersBack(queueId, refreshableSlots, 'prebid');
                  },
                  this.onError
                );
              },
            }),
          this.onError
        );
      }

      if (isApsTagUsed) {
        logMessage('queueBids apstag apsSlots', apsSlots);
        if (apsSlots && apsSlots.length > 0) {
          requestQueue.apsDone = false;
          window.apstag.fetchBids({
            slots: apsSlots,
            timeout: 3500
          }, (bids) => {
            Advertising.queueForGPT(
              () => {
                const returnedBidsIds = Object.keys(bids);
                window.apstag.setDisplayBids();
                logMessage('queueBids apstag queueForGPT bids done', returnedBidsIds, Date.now() - requestQueue.data.started);
                requestQueue.apsDone = true; // signals that APS request has completed
                requestManager.biddersBack(queueId, refreshableSlots, 'apstag');
              },
              this.onError
            );
          });
        }
      }
    } else {
      Advertising.queueForGPT(
        () => {
          logMessage('queueBids no prebid/apstag queueForGPT', refreshableSlots);
          window.googletag.pubads().refresh(refreshableSlots);
        },
        this.onError
      );
    }
  }

  isConfigReady() {
    return Boolean(this.config);
  }

  setConfig(config) {
    this.config = config;
    this.setDefaultConfig();
  }

  // ---------- PRIVATE METHODS ----------

  setupCustomEvents() {
    if (!this.config.customEvents) {
      return;
    }
    Object.keys(this.config.customEvents).forEach((customEventId) =>
      this.setupCustomEvent(
        customEventId,
        this.config.customEvents[customEventId]
      )
    );
  }

  setupCustomEvent(customEventId, { eventMessagePrefix, divIdPrefix }) {
    const { customEventCallbacks } = this;
    this.customEventHandlers[customEventId] = ({ data }) => {
      if (
        typeof data !== 'string' ||
        !data.startsWith(`${eventMessagePrefix}`)
      ) {
        return;
      }
      const divId = `${divIdPrefix || ''}${data.substr(
        eventMessagePrefix.length
      )}`;
      const callbacks = customEventCallbacks[customEventId];
      if (!callbacks) {
        return;
      }
      const callback = callbacks[divId];
      if (callback) {
        callback();
      }
    };
    window.addEventListener('message', this.customEventHandlers[customEventId]);
  }

  teardownCustomEvents() {
    if (!this.config.customEvents) {
      return;
    }
    Object.keys(this.config.customEvents).forEach((customEventId) =>
      window.removeEventListener(
        'message',
        this.customEventHandlers[customEventId]
      )
    );
  }

  defineGptSizeMappings() {
    if (!this.config.sizeMappings) {
      return;
    }
    const entries = Object.entries(this.config.sizeMappings);
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      const sizeMapping = window.googletag.sizeMapping();
      for (let q = 0; q < value.length; q++) {
        const { viewPortSize, sizes } = value[q];
        sizeMapping.addSize(viewPortSize, sizes);
      }
      this.gptSizeMappings[key] = sizeMapping.build();
    }
  }

  getGptSizeMapping(sizeMappingName) {
    return sizeMappingName && this.gptSizeMappings[sizeMappingName]
      ? this.gptSizeMappings[sizeMappingName]
      : null;
  }

  defineSlots() {
    this.config.slots.forEach(
      ({
        id,
        path,
        collapseEmptyDiv,
        targeting = {},
        sizes,
        sizeMappingName,
      }) => {
        const slot = window.googletag.defineSlot(
          path || this.config.path,
          sizes,
          id
        );

        const sizeMapping = this.getGptSizeMapping(sizeMappingName);
        if (sizeMapping) {
          slot.defineSizeMapping(sizeMapping);
        }

        if (
          collapseEmptyDiv &&
          collapseEmptyDiv.length &&
          collapseEmptyDiv.length > 0
        ) {
          slot.setCollapseEmptyDiv(...collapseEmptyDiv);
        }

        const entries = Object.entries(targeting);
        for (let i = 0; i < entries.length; i++) {
          const [key, value] = entries[i];
          slot.setTargeting(key, value);
        }

        slot.addService(window.googletag.pubads());

        this.slots[id] = slot;
      }
    );
  }

  defineOutOfPageSlots() {
    if (this.config.outOfPageSlots) {
      this.config.outOfPageSlots.forEach(({ id, path }) => {
        const slot = window.googletag.defineOutOfPageSlot(
          path || this.config.path,
          id
        );
        slot.addService(window.googletag.pubads());
        this.outOfPageSlots[id] = slot;
      });
    }
  }

  displaySlots() {
    this.executePlugins('displaySlots');
    this.config.slots.forEach(({ id }) => {
      window.googletag.display(id);
    });
  }

  displayOutOfPageSlots() {
    this.executePlugins('displayOutOfPageSlot');
    if (this.config.outOfPageSlots) {
      this.config.outOfPageSlots.forEach(({ id }) => {
        window.googletag.display(id);
      });
    }
  }

  setupPrebid() {
    this.executePlugins('setupPrebid');
    const adUnits = getAdUnits(this.config.slots);
    window.pbjs.addAdUnits(adUnits);
    window.pbjs.setConfig(this.config.prebid);
  }

  teardownPrebid() {
    this.executePlugins('teardownPrebid');
    getAdUnits(this.config.slots).forEach(({ code }) =>
      window.pbjs.removeAdUnit(code)
    );
  }

  setupGpt() {
    this.executePlugins('setupGpt');
    logMessage('setupGpt', requestManager.queues);
    const pubads = window.googletag.pubads();
    const { targeting } = this.config;
    this.defineGptSizeMappings();
    this.defineSlots();
    this.defineOutOfPageSlots();
    const entries = Object.entries(targeting);
    for (let i = 0; i < entries.length; i++) {
      const [key, value] = entries[i];
      pubads.setTargeting(key, value);
    }
    pubads.disableInitialLoad();
    pubads.enableSingleRequest();

    window.googletag.enableServices();
    this.displaySlots();
    this.displayOutOfPageSlots();
  }

  teardownGpt() {
    this.executePlugins('teardownGpt');
    window.googletag.destroySlots();
  }

  setDefaultConfig() {
    if (!this.config) {
      return;
    }
    if (!this.config.prebid) {
      this.config.prebid = {};
    }
    if (!this.config.metaData) {
      this.config.metaData = {};
    }
    if (!this.config.targeting) {
      this.config.targeting = {};
    }
    if (this.config.enableLazyLoad === true) {
      this.config.enableLazyLoad = defaultLazyLoadConfig;
    }
    if (this.config.slots) {
      this.config.slots = this.config.slots.map((slot) => {
        const isLazyLoadingEnabled = slot.enableLazyLoad === true;
        const newSlot = isLazyLoadingEnabled ? { ...slot, enableLazyLoad: defaultLazyLoadConfig } : slot;
        return newSlot;
      });
    }
  }

  executePlugins(method) {
    for (let i = 0; i < this.plugins.length; i++) {
      const func = this.plugins[i][method];
      if (func) {
        func.call(this);
      }
    }
  }

  static queueForGPT(func, onError) {
    return Advertising.withQueue(window.googletag.cmd, func, onError);
  }

  static queueForPrebid(func, onError) {
    return Advertising.withQueue(window.pbjs.que, func, onError);
  }

  static withQueue(queue, func, onError) {
    return new Promise((resolve) =>
      queue.push(() => {
        try {
          func();
          resolve();
        } catch (error) {
          onError(error);
        }
      })
    );
  }
}
