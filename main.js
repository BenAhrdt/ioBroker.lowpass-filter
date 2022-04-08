"use strict";

/*
 * Created with @iobroker/create-adapter v2.1.0
 */

// The adapter-core module gives you access to the core ioBroker functions
// you need to create an adapter
const utils = require("@iobroker/adapter-core");
const schedule = require("node-schedule");

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

		// define cron jobs
		this.cronJobs = {};
		this.jobId = "job";
	}


	/***************************************************************************************
	 * ********************************** Init *********************************************
	 ***************************************************************************************/

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

		// Request if there is an object
		if(customStateArray && customStateArray.rows)
		{
			for(let index = 0 ; index < customStateArray.rows.length ; index++){
				if(customStateArray.rows[index].value !== null){
					// Request if there is an object for this namespace an its enabled
					if (customStateArray.rows[index].value[this.namespace] && customStateArray.rows[index].value[this.namespace].enabled === true) {
						const id = customStateArray.rows[index].id;
						const obj = await this.getForeignObjectAsync(id);
						if(obj){
							const common = obj.common;
							const state = await this.getForeignStateAsync(id);
							if(state){
								await this.addObjectAndCreateState(id,common,customStateArray.rows[index].value[this.namespace],state);
							}
						}
					}
				}
			}
		}

		this.subscribeForeignObjects("*");
		this.setState(this.subscribecounterId,this.subscribecounter,true);
		this.setState("info.connection", true, true);
	}

	/***************************************************************************************
	 * ********************************** Changes ******************************************
	 ***************************************************************************************/

	async onObjectChange(id, obj) {
		if (obj) {
			try {
				// Load configuration as provided in object
				const stateInfo = await this.getForeignObjectAsync(id);
				if (!stateInfo) {
					this.log.error(`Can't get information for ${id}, state will be ignored`);
					return;
				} else
				{
					if(!stateInfo.common.custom || !stateInfo.common.custom[this.namespace]){
						if(this.activeStates[id])
						{
							this.clearStateArrayElement(id,false);
							return;
						}
					}
					else{
						const customInfo = stateInfo.common.custom[this.namespace];
						if(this.activeStates[id])
						{
							this.activeStates[id].filterTime =  customInfo.filterTime;
							this.activeStates[id].separateFilterTimeForNegativeDifference =  customInfo.separateFilterTimeForNegativeDifference;
							this.activeStates[id].filterTimeNegative =  customInfo.filterTimeNegative;
							this.activeStates[id].refreshWithStatechange = customInfo.refreshWithStatechange;
							if(this.activeStates[id].refreshRate != customInfo.refreshRate)
							{
								this.removeIdFromSchedule(id);
								this.activeStates[id].refreshRate =  customInfo.refreshRate;
								this.addIdToSchedule(id);

							}
							this.output(id);
						}
						else
						{
							const state = await this.getForeignStateAsync(id);
							if(state)
							{
								this.addObjectAndCreateState(id,stateInfo.common,customInfo,state);
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
				this.clearStateArrayElement(id,false);
			}
		} else {
			// The object was deleted
			// Check if the object is kwnow
			const obj = await this.getObjectAsync(this.createStatestring(id));
			if(this.activeStates[id] || obj)
			{
				if(obj){
					this.clearStateArrayElement(id,true);
				}
				else{
					this.clearStateArrayElement(id,false);
				}
			}
		}
	}

	/**
	 * Is called if a subscribed state changes
	 * @param {string} id
	 * @param {ioBroker.State | null | undefined} state
	 */
	onStateChange(id, state) {
		if (state) {
			if(this.activeStates[id])
			{
				this.activeStates[id].currentValue = state.val;
				if(	this.activeStates[id].refreshRate == 0 || this.activeStates[id].refreshWithStatechange){
					this.output(id);
				}
				else{
					this.calculateLowpassValue(id);
				}
			}
		} else {
			// The state was deleted
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


	/***************************************************************************************
	 * *********************************** Unload ******************************************
	 ***************************************************************************************/

	/**
 * Is called when adapter shuts down - callback has to be called under any circumstances!
 * @param {() => void} callback
 */
	onUnload(callback) {
		try {
			// clear all schedules
			for(const seconds in this.cronJobs)
			{
				schedule.cancelJob(this.cronJobs[seconds][this.jobId]);
			}
			callback();
		} catch (e) {
			callback();
		}
	}

	/***************************************************************************************
	 * ************************** own defined functions ************************************
	 ***************************************************************************************/

	/***************************************************************************************
	 * **************************** custom objec handling **********************************
	 ***************************************************************************************/


	createStatestring(id){
		return `filtered_Values.${id.replace(/\./g, "_")}`;
	}

	async addObjectAndCreateState(id,common,customInfo,state)
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
			separateFilterTimeForNegativeDifference: customInfo.separateFilterTimeForNegativeDifference,
			filterTimeNegative: customInfo.filterTimeNegative,
			refreshRate:customInfo.refreshRate,
			refreshWithStatechange:customInfo.refreshWithStatechange
		};

		// assign cronJob
		this.addIdToSchedule(id);

		// Create Object
		await this.setObjectNotExistsAsync(this.createStatestring(id),{
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
		this.log.info(`state ${id} added`);
		this.subscribeForeignStates(id);
		this.subscribecounter += 1;
		this.setState(this.subscribecounterId,this.subscribecounter,true);
		await this.output(id);
	}

	// clear the state from the active array. if selected the state will be deleted
	clearStateArrayElement(id,deleteObject)
	{
		if(this.activeStates[id])
		{
			this.removeIdFromSchedule(id);
			delete this.activeStates[id];
			this.subscribecounter -= 1;
			this.setState(this.subscribecounterId,this.subscribecounter,true);
			this.unsubscribeForeignStates(id);
			this.log.info(`state ${id} removed`);
			if(this.config.deleteStatesWithDisable || deleteObject){
				this.delObjectAsync(this.createStatestring(id));
				this.log.info(`state ${this.namespace}.${this.createStatestring(id)} deleted`);
			}
		}
		else if(deleteObject){
			this.delObjectAsync(this.createStatestring(id));
			this.log.info(`state ${this.namespace}.${this.createStatestring(id)} deleted`);
		}
	}

	/***************************************************************************************
	 * *********************************** Schedule ****************************************
	 ***************************************************************************************/

	addIdToSchedule(id)
	{
		if(this.activeStates[id].refreshRate != 0){
			if(!this.cronJobs[this.activeStates[id].refreshRate]){
				this.cronJobs[this.activeStates[id].refreshRate] = {};
				if(this.activeStates[id].refreshRate != 60){
					this.cronJobs[this.activeStates[id].refreshRate][this.jobId] = schedule.scheduleJob(`*/${this.activeStates[id].refreshRate} * * * * *`,this.outputAddedIds.bind(this,this.activeStates[id].refreshRate));
				}
				else{
					this.cronJobs[this.activeStates[id].refreshRate][this.jobId] = schedule.scheduleJob(`0 * * * * *`,this.outputAddedIds.bind(this,this.activeStates[id].refreshRate));
				}

			}
			// Add id to object
			this.cronJobs[this.activeStates[id].refreshRate][id] = {};
		}
	}

	// if the id is scheduled, it will be deleted from active array
	removeIdFromSchedule(id)
	{
		if(this.activeStates[id].refreshRate != 0){
			delete this.cronJobs[this.activeStates[id].refreshRate][id];
			if(Object.keys(this.cronJobs[this.activeStates[id].refreshRate]).length <= 1)
			{
				schedule.cancelJob(this.cronJobs[this.activeStates[id].refreshRate][this.jobId]);
				delete this.cronJobs[this.activeStates[id].refreshRate];
			}
		}
	}

	// output all added id of the given schedule
	outputAddedIds(seconds){
		for(const id in this.cronJobs[seconds]){
			if(id == this.jobId){continue;}
			this.output(id);
		}
	}

	/***************************************************************************************
	 * **************************** calculation of filter **********************************
	 ***************************************************************************************/

	calculateLowpassValue(id)
	{
		const timestamp = Date.now();
		let filterTime = 0;
		if(this.activeStates[id].currentValue >= this.activeStates[id].lowpassValue || !this.activeStates[id].separateFilterTimeForNegativeDifference){
			filterTime = this.activeStates[id].filterTime;
		}
		else{
			filterTime = this.activeStates[id].filterTimeNegative;
		}

		if(filterTime != 0){
			this.activeStates[id].lowpassValue += (this.activeStates[id].lastValue - this.activeStates[id].lowpassValue) *
										(1 - Math.exp(-(timestamp-this.activeStates[id].lastTimestamp)/(filterTime  * 200)));
		}
		else{
			this.activeStates[id].lowpassValue = this.activeStates[id].currentValue;
		}
		this.activeStates[id].lastTimestamp = timestamp;
		this.activeStates[id].lastValue = this.activeStates[id].currentValue;
	}

	// output the calculatied values
	async output(id)
	{
		this.calculateLowpassValue(id);
		// Forreign wird hier verwendet, damit der Adapter eigene States wiederum filtern kann (Filter des Filters)
		await this.setStateAsync(this.createStatestring(id),this.activeStates[id].lowpassValue,true);
	}
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