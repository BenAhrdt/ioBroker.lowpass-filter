"use strict";

/*
 * Created with @iobroker/create-adapter v2.1.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const { time } = require("console");
const { exit } = require("process");

// Load your modules here, e.g.:
// const fs = require("fs");

class LowpassFilter extends utils.Adapter {

	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	constructor(options) {
		super({
			...options,
			name: "lowpass-filter",
		});
		this.on("ready", this.onReady.bind(this));
		this.on("stateChange", this.onStateChange.bind(this));
		this.on("objectChange", this.onObjectChange.bind(this));
		// this.on("message", this.onMessage.bind(this));
		this.on("unload", this.onUnload.bind(this));

		// define arrays for selected states and calculation
		this.activeStates = {};
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here
	//	this.myele["a"] = {val:1};

		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);

		// The adapters config (in the instance object everything under the attribute "native") is accessible via
		// this.config:
		this.log.info("config option1: " + this.config.option1);
		this.log.info("config option2: " + this.config.option2);

		await this.setObjectNotExistsAsync("testVariable", {
			type: "state",
			common: {
				name: "testVariable",
				type: "boolean",
				role: "indicator",
				read: true,
				write: true,
			},
			native: {},
		});

	//	this.output();

		// In order to get state updates, you need to subscribe to them. The following line adds a subscription for our variable we have created above.
		this.subscribeStates("testVariable");
		this.subscribeForeignObjects("*");

		this.setState("info.connection", true, true);
	}

	calculateLowpassValue(id)
	{
		const timestamp = Date.now();
		this.activeStates[id].lowpassValue += (this.activeStates[id].lastValue - this.activeStates[id].lowpassValue) *
									(1 - Math.exp(-(timestamp-this.activeStates[id].lastTimestamp)/(this.activeStates[id].filterTime  * 200)));
		this.activeStates[id].lastTimestamp = timestamp;
		this.activeStates[id].lastValue = this.activeStates[id].currentValue;
	}

	output(id)
	{
		this.calculateLowpassValue(id);
		this.setState(id,this.activeStates[id].lowpassValue,true);
		this.activeStates[id].timeout = this.setTimeout(this.output.bind(this,id),this.activeStates[id].refreshRate * 1000,this.activeStates[id]);
	}
	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// Here you must clear all timeouts or intervals that may still be active
			// clearTimeout(timeout1);
			// clearTimeout(timeout2);
			// ...
			// clearInterval(interval1);

			callback();
		} catch (e) {
			callback();
		}
	}

	// If you need to react to object changes, uncomment the following block and the corresponding line in the constructor.
	// You also need to subscribe to the objects with `this.subscribeObjects`, similar to `this.subscribeStates`.
	// /**
	//  * Is called if a subscribed object changes
	//  * @param {string} id
	//  * @param {ioBroker.Object | null | undefined} obj
	//  */
	async onObjectChange(id, obj) {
		if (obj) {
			// The object was changed
			this.log.info(`object ${id} changed: ${JSON.stringify(obj)}`);


			try {
				// Load configuration as provided in object
				const stateInfo = await this.getForeignObjectAsync(id);
				if (!stateInfo) {
					this.log.error(`Can't get information for ${id}, state will be ignored`);
					delete this.activeStates[id];
					this.unsubscribeForeignStates(id);
					return;
				} else
				{
					const customInfo = stateInfo.common.custom[this.name + "." + this.instance];
					let foundedKey = "";
					for(const key in this.activeStates){
						if(key == id)
						{
							foundedKey = key;
							exit;
						}
					}
					if(foundedKey != "")
					{
						this.activeStates[foundedKey].filterTime =  customInfo.filterTime;
						this.activeStates[foundedKey].refreshRate =  customInfo.refreshRate;
					}
					else
					{
						this.subscribeForeignStates(id);
						const state = await this.getForeignStateAsync(id);
						this.activeStates[id] = {
							lastValue:state.val,
							currentValue: state.val,
							lowpassValue:state.val,
							lastTimestamp:Date.now(),
							filterTime:customInfo.filterTime / 5,
							refreshRate:customInfo.refreshRate,
							timeout:undefined
						};
						await this.setObjectNotExistsAsync(id, {
							type: "state",
							common: {
								name: stateInfo.common.name,
								type: "number",
								role: "indicator",
								read: true,
								write: true,
								def:state.val
							},
							native: {},
						});
						this.output(id);
					}
				}
			} catch (error) {
				this.clearTimeout(this.activeStates[id].timeout);
				delete this.activeStates[id];
				this.unsubscribeForeignStates(id);
				return;
			}

		} else {
			// The object was deleted
			this.log.info(`object ${id} deleted`);
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			// The state was changed
			this.log.info(`state ${id} changed: ${state.val} (ack = ${state.ack})`);

			for(const key in this.activeStates)
			{
				if(key == id)
				{
					this.activeStates[key].currentValue = state.val;
					this.calculateLowpassValue(id);
					exit;
				}
			}
		} else {
			// The state was deleted
			this.log.info(`state ${id} deleted`);
		}
	}

	// If you need to accept messages in your adapter, uncomment the following block and the corresponding line in the constructor.
	// /**
	//  * Some message was sent to this instance over message box. Used by email, pushover, text2speech, ...
	//  * Using this method requires "common.messagebox" property to be set to true in io-package.json
	//  * @param {ioBroker.Message} obj
	//  */
	// onMessage(obj) {
	// 	if (typeof obj === "object" && obj.message) {
	// 		if (obj.command === "send") {
	// 			// e.g. send email or pushover or whatever
	// 			this.log.info("send command");

	// 			// Send response in callback if required
	// 			if (obj.callback) this.sendTo(obj.from, obj.command, "Message received", obj.callback);
	// 		}
	// 	}
	// }

}

if (require.main !== module) {
	// Export the constructor in compact mode
	/**
	 * @param {Partial<utils.AdapterOptions>} [options={}]
	 */
	module.exports = (options) => new LowpassFilter(options);
} else {
	// otherwise start the instance directly
	new LowpassFilter();
}