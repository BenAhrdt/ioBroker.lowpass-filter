"use strict";

/*
 * Created with @iobroker/create-adapter v2.1.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");

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

		this.subscribecounterId = "info.subscribedStatesCount";
		this.subscribecounter = 0;

		// define arrays for selected states and calculation
		this.activeStates = {};
	}

	/**
	 * Is called when databases are connected and adapter received configuration.
	 */
	async onReady() {
		// Initialize your adapter here
		// Reset the connection indicator during startup
		this.setState("info.connection", false, true);

		// Creates the subscribed state count
		await this.setObjectNotExistsAsync(this.subscribecounterId, {
			type: "state",
			common: {
				name: "Count of subscribed states",
				type: "number",
				role: "indicator",
				read: true,
				write: false,
				def:0
			},
			native: {},
		});

		//Read all states with custom configuration
		const customStateArray = await this.getObjectViewAsync("system","custom",{});

		if(customStateArray && customStateArray.rows)
		{
			for(let i = 0 ; i < customStateArray.rows.length ; i++)
			{
				if(customStateArray.rows[i].value)
				{
					const id = customStateArray.rows[i].id;
					const history = {};
					history[id] = customStateArray.rows[i].value;

					if (!history[id][this.namespace] || history[id][this.namespace].enabled === false) {
						// Not lowpass-filter relevant ignore
					} else {
						this.log.debug(`lowpass-filter enabled state found ${id}`);
						const obj = await this.getForeignObjectAsync(id);
						if(obj){
							const common = obj.common;
							const state = await this.getForeignStateAsync(id);
							if(state){
								this.AddObjectAndCreateState(id,common,history[id][this.namespace],state);
							}
						}
					}
				}
			}
		}

		this.subscribeForeignObjects("*");

		this.setState("info.connection", true, true);
	}

	calculateLowpassValue(activeState)
	{
		const timestamp = Date.now();
		if(activeState.filterTime != 0){
			activeState.lowpassValue += (activeState.lastValue - activeState.lowpassValue) *
										(1 - Math.exp(-(timestamp-activeState.lastTimestamp)/(activeState.filterTime  * 200)));
		}
		else{
			activeState.lowpassValue = activeState.currentValue;
		}
		activeState.lastTimestamp = timestamp;
		activeState.lastValue = activeState.currentValue;
	}

	output(activeState)
	{
		activeState.timeout = undefined;
		this.calculateLowpassValue(activeState);
		// Forreign wird hier verwendet, damit der Adapter eigene States wiederum filtern kann (Filter des Filters)
		this.setForeignState(this.namespace + "." + activeState.stateId,activeState.lowpassValue,true);
		activeState.timeout = this.setTimeout(this.output.bind(this),activeState.refreshRate * 1000,activeState);
	}



	async AddObjectAndCreateState(id,common,customInfo,state)
	{
		// check if custominfo is available
		if(!customInfo){
			return;
		}
		if(common.type != "number")
		{
			this.log.error(`state ${id} is not type number, but ${common.type}`);
			return;
		}
		this.activeStates[id] = {
			stateId:id,
			lastValue:state.val,
			currentValue: state.val,
			lowpassValue:state.val,
			lastTimestamp:Date.now(),
			filterTime:customInfo.filterTime,
			refreshRate:customInfo.refreshRate,
			timeout:undefined
		};
		// Forreign wird hier verwendet, damit der Adapter eigene States wiederum filtern kann (Filter des Filters)
		this.setForeignObjectNotExistsAsync(this.namespace + "." + id,{
			type: "state",
			common: {
				name: common.name,
				type: "number",
				role: "indicator",
				read: true,
				write: false,
				def:state.val
			},
			native: {},
		});
		this.subscribeForeignStates(id);
		this.subscribecounter += 1;
		this.setState(this.subscribecounterId,this.subscribecounter,true);
		this.output(this.activeStates[id]);
	}

	clearStateArrayElement(id)
	{
		if(this.activeStates[id])
		{
			if(this.activeStates[id].timeout != undefined){
				this.clearTimeout(this.activeStates[id].timeout);
			}
			if(this.config.deleteStatesWithDisable){
				this.delObjectAsync(this.namespace + "." + id);
			}

			delete this.activeStates[id];
			this.subscribecounter -= 1;
			this.setState(this.subscribecounterId,this.subscribecounter,true);
			this.unsubscribeForeignStates(id);
		}
	}

	/**
	 * Is called when adapter shuts down - callback has to be called under any circumstances!
	 * @param {() => void} callback
	 */
	onUnload(callback) {
		try {
			// clear all timeouts
			for(const key in this.activeStates)
			{
				if(this.activeStates[key].timeout != undefined)
				{
					this.clearTimeout(this.activeStates[key].timeout);
					this.activeStates[key].timeout = undefined;
				}
			}

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
			try {
				// Load configuration as provided in object
				const stateInfo = await this.getForeignObjectAsync(id);
				if (!stateInfo) {
					this.log.error(`Can't get information for ${id}, state will be ignored`);
					if(this.activeStates[id] != undefined)
					{
						this.clearStateArrayElement(id);
					}
					return;
				} else
				{
					let foundedKey = "";
					for(const key in this.activeStates){
						if(key == id)
						{
							foundedKey = key;
							break;
						}
					}
					if(!stateInfo.common.custom){
						if(foundedKey != "")
						{
							this.clearStateArrayElement(id);
							return;
						}
					}
					else{
						this.log.info(id);
						const customInfo = stateInfo.common.custom[this.namespace];
						if(foundedKey != "")
						{
							this.activeStates[foundedKey].filterTime =  customInfo.filterTime;
							this.activeStates[foundedKey].refreshRate =  customInfo.refreshRate;
							if(this.activeStates[foundedKey].timeout == undefined)
							{
								this.output(this.activeStates[foundedKey]);
							}
						}
						else
						{
							const state = await this.getForeignStateAsync(id);
							if(state)
							{
								this.AddObjectAndCreateState(id,stateInfo.common,customInfo,state);
							}
							else
							{
								this.log.error(`could not read state ${id}`);
							}
						}
					}
				}
			} catch (error) {
				this.log.error(error);
				this.clearStateArrayElement(id);
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
			for(const key in this.activeStates)
			{
				if(key == id)
				{
					this.activeStates[key].currentValue = state.val;
					if(	this.activeStates[key].filterTime == 0)
					{
						if(this.activeStates[key].timeout != undefined)
						{
							this.clearTimeout(this.activeStates[key].timeout);
							this.activeStates[key].timeout = undefined;
						}
						this.output(this.activeStates[key]);
					}
					else{
						this.calculateLowpassValue(this.activeStates[key]);
					}
					break;
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