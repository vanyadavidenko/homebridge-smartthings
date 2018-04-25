var fs = require('fs')
var path = require('path')
var PubNub = require('pubnub')
var smartthings = require('./lib/smartthingsapi');
var http = require('http')
var os = require('os');

var Service, Characteristic, Accessory, uuid, EnergyCharacteristics;

var SmartThingsAccessory;

module.exports = function (homebridge) {
	Service = homebridge.hap.Service;
	Characteristic = homebridge.hap.Characteristic;
	Accessory = homebridge.hap.Accessory;
	uuid = homebridge.hap.uuid;

	homebridge.registerPlatform("homebridge-smartthings", "SmartThings", SmartThingsPlatform);
};

function SmartThingsPlatform(log, config) {
	// Load Wink Authentication From Config File
	this.app_url = config["app_url"];
	this.app_id = config["app_id"];
	this.access_token = config["access_token"];
	this.excludedCapabilities = config["excluded_capabilities"] || {};

	//This is how often it does a full refresh
	this.polling_seconds = config["polling_seconds"];
	if (!this.polling_seconds) this.polling_seconds = 3600; //Get a full refresh every hour.

	//This is how often it polls for subscription data.
	this.update_method = config["update_method"];
	if (!this.update_method) this.update_method = 'direct';

	this.update_seconds = config["update_seconds"];
	if (!this.update_seconds) this.update_seconds = 30; //30 seconds is the new default
	if (this.update_method === 'api' && this.update_seconds < 30)
		that.log("The setting for update_seconds is lower than the SmartThings recommended value. Please switch to direct or PubNub using a free subscription for real-time updates.");

	this.direct_port = config["direct_port"];
	if (!this.direct_port) this.direct_port = 8000;

	this.direct_ip = config["direct_ip"];
	if (!this.direct_ip) this.direct_ip = smartthing_getIP();

	this.api = smartthings;
	this.log = log;
	this.deviceLookup = {};
	this.firstpoll = true;
	this.attributeLookup = {}
}

SmartThingsPlatform.prototype = {
	reloadData: function (callback) {
		var that = this;
		var foundAccessories = [];
		this.log.debug("Refreshing All Device Data");
		smartthings.getDevices(function (myList) {
			that.log.debug("Received All Device Data");

			//Load Device Templates
			var deviceTemplates;
			try {
				deviceTemplates = JSON.parse(fs.readFileSync(path.resolve(__dirname, 'DeviceTemplates.json')));
			}
			catch (err) {
				that.log.error("There was a problem reading your DeviceTemplates.json file.");
				that.log.error("");
				throw err;
			}
			//Parse any Device Templates identified in the config file. Make sure that user-defined rules are pushed to the front.

			function applyTemplate(newDevice, template) {
				//Add Services if needed
				if (template === undefined) return;
				if (!template.AddServices) template.AddServices = {};
				if (!template.GetServices) template.GetServices = {};

				for (var i = 0; i < template.AddServices.length; i++) {
					var serviceEntry = template.AddServices[i];
					if (Service[serviceEntry.ServiceName] !== undefined) {
						var myService = newDevice.getService(Service[serviceEntry.ServiceName]);
						if (!myService) myService = newDevice.addService(Service[serviceEntry.ServiceName]);
						for (j = 0; j < template.AddServices[i].AddCharacteristics.length; j++) {
							var characteristicEntry = template.AddServices[i].AddCharacteristics[j];
							if (Characteristic[characteristicEntry.name] !== undefined) {
								var mycharacteristic = myService.getCharacteristic(Characteristic[characteristicEntry.name]);
								//if (characteristicEntry["read"]!==undefined)
								//Need to define this manually from the config. Must pass a callback to the action.
								var device = newDevice.context;
								var readFunction = null;
								var writeFunction = null;
								if (characteristicEntry["read"]) eval('readFunction = function(callback) { ' + characteristicEntry["read"] + '}')
								if (characteristicEntry["write"]) eval('writeFunction = function(value, callback) { ' + characteristicEntry["write"] + '}')
								if (readFunction) mycharacteristic.on('get', readFunction);
								if (writeFunction) mycharacteristic.on('set', writeFunction);

							}
						}
					}
				}
				//Add Characteristics.
				//If a characteristic already exists, don't touch it.
			}

			//Transform List to something slightly more generic. There really isn't much to do with the transform.
			var rawList = {};
			if (myList && myList.deviceList && myList.deviceList instanceof Array) {
				if (myList && myList.location) {
					that.temperature_unit = myList.location.temperature_scale;
				}
				for (var i = 0; i < myList.deviceList.length; i++) {
					var stDevice = myList.deviceList[i];

					//Need to create an accessory out of this.
					var newDevice = new Accessory(stDevice.name, stDevice.deviceid)
					newDevice.getServices = function () { return this.services; };
					newDevice.base_uuid = stDevice.deviceid;
					newDevice.name = stDevice.name;
					newDevice.context = {};
					newDevice.context.name = stDevice.name;
					newDevice.context.uuid = stDevice.deviceid;
					newDevice.context.typeDescription = stDevice.type;
					newDevice.context.manufacturer = stDevice.manufacturerName;
					newDevice.context.model = stDevice.modelName;
					newDevice.context.attributes = stDevice.attributes;
					newDevice.context.actions = {};
					for (commandName in stDevice.commands) {
						var myAction = ''
						if (stDevice.commands[commandName].length == 0) {
							myAction = "function(callback) { that.api.runCommand(callback, '" + newDevice.context.uuid + "', '" + commandName + "', { }); }"
						} else if (stDevice.commands[commandName].length == 1) {
							myAction = "function(callback, value1) { that.api.runCommand(callback, '" + newDevice.context.deviceid + "', '" + commandName + "', { value1: value1 }); }";
						} else if (stDevice.commands[commandName].length == 2) {
							myAction = "function(callback, value1, value2) { that.api.runCommand(callback, '" + newDevice.context.deviceid + "', '" + commandName + "', { value1: value1, value2: value2 }); }";
						} else if (stDevice.commands[commandName].length == 3) {
							myAction = "function(callback, value1, value2, value3) { that.api.runCommand(callback, '" + newDevice.context.deviceid + "', '" + commandName + "', { value1: value1, value2: value2, value3: value3 }); }";
						}
						eval("newDevice.context.actions['" + commandName + "']=" + myAction);
					}
					newDevice.context.basename = stDevice.basename;
					newDevice.context.capabilities = stDevice.capabilities;
					newDevice.context.lastTime = stDevice.basename;
					newDevice.context.status = stDevice.status;
					newDevice.context.discoveredTemplates = [];

					var TemplatesToApply = [];
					//First check by DeviceID
					if (deviceTemplates.TemplateRulesByDeviceID[newDevice.context.uuid] !== undefined)
						newDevice.context.discoveredTemplates = deviceTemplates.TemplateRulesByDeviceID[newDevice.context.uuid]
					//Now check by Device Type. This equates to the ST app that controls the device.
					else if (deviceTemplates.TemplateRulesByDeviceType[newDevice.context.typeDescription] !== undefined)
						newDevice.context.discoveredTemplates = deviceTemplates.TemplateRulesByDeviceType[newDevice.context.typeDescription]
					//Now check through interrogation. This is the array of rules to determine the right thing to assign.
					else {
						for (j = 0; j < deviceTemplates.TemplateRulesByDeviceInterrogation.length; j++) {
							var myFunction = function (device) { return false };
							eval("myFunction = function(device) { " + deviceTemplates.TemplateRulesByDeviceInterrogation[j].InterrogationFunction + " };")
							if (myFunction(newDevice.context)) //Runs the user-defined funtion. Need to add some kind of error trapping...
								newDevice.context.discoveredTemplates = newDevice.context.discoveredTemplates.concat(deviceTemplates.TemplateRulesByDeviceInterrogation.Templates);
						}
					}

					if ((newDevice.context.discoveredTemplates !== undefined) && (newDevice.context.discoveredTemplates.length > 0)) {
						for (myTemplate in newDevice.context.discoveredTemplates)
							applyTemplate(newDevice, deviceTemplates.Templates[newDevice.context.discoveredTemplates[myTemplate]]);
						console.log("Discovered device: " + newDevice.context.name);
						if ((newDevice.services.length > 1)&&(rawList[newDevice.context.uuid] === undefined)) {
							rawList[newDevice.context.uuid] = newDevice;
							foundAccessories.push(newDevice);
						}

					} else {
						console.log("Unable to discover for device: " + newDevice.context.name);
					}
				}
			} else if ((!myList) || (!myList.error)) {
				that.log("Invalid Response from API call");
			} else if (myList.error) {
				that.log("Error received type " + myList.type + ' - ' + myList.message);
			} else {
				that.log("Invalid Response from API call");
			}
			if (callback)
				callback(foundAccessories)
			that.firstpoll = false;
			//rawList["d38a5ae8-9533-43cd-b573-f5625aa07695"].context.actions.off();
		});
	},
	accessories: function (callback) {
		this.log("Fetching Smart Things devices.");

		var that = this;
		var foundAccessories = [];
		this.deviceLookup = [];
		this.unknownCapabilities = [];
		this.knownCapabilities = ["Switch", "Light", "Color Control", "Battery", "Polling", "Lock", "Refresh", "Lock Codes", "Sensor", "Actuator",
			"Configuration", "Switch Level", "Temperature Measurement", "Illuminance Measurement", "Motion Sensor", "Color Temperature",
			"Contact Sensor", "Three Axis", "Acceleration Sensor", "Momentary", "Door Control", "Garage Door Control",
			"Relative Humidity Measurement", "Presence Sensor", "Thermostat", "Energy Meter", "Power Meter",
			"Thermostat Cooling Setpoint", "Thermostat Mode", "Thermostat Fan Mode", "Thermostat Operating State",
			"Thermostat Heating Setpoint", "Thermostat Setpoint", "Indicator"];
		this.temperature_unit = 'F';

		smartthings.init(this.app_url, this.app_id, this.access_token);

		this.reloadData(callback);
	},
	addAttributeUsage: function (attribute, deviceid, mycharacteristic) {
		if (!this.attributeLookup[attribute])
			this.attributeLookup[attribute] = {};
		if (!this.attributeLookup[attribute][deviceid])
			this.attributeLookup[attribute][deviceid] = [];
		this.attributeLookup[attribute][deviceid].push(mycharacteristic);
	},

	doIncrementalUpdate: function () {
		var that = this;
		smartthings.getUpdates(function (data) { that.processIncrementalUpdate(data, that) });
	},

	processIncrementalUpdate: function (data, that) {
		if (data && data.attributes && data.attributes instanceof Array) {
			for (var i = 0; i < data.attributes.length; i++) {
				that.processFieldUpdate(data.attributes[i], that);

			}
		}
	},

	processFieldUpdate: function (attributeSet, that) {
		//that.log("Processing Update");
		if (!((that.attributeLookup[attributeSet.attribute]) && (that.attributeLookup[attributeSet.attribute][attributeSet.device]))) return;
		var myUsage = that.attributeLookup[attributeSet.attribute][attributeSet.device];
		if (myUsage instanceof Array) {
			for (var j = 0; j < myUsage.length; j++) {
				var accessory = that.deviceLookup[attributeSet.device];
				if (accessory) {
					accessory.device.attributes[attributeSet.attribute] = attributeSet.value;
					myUsage[j].getValue();
				}
			}
		}
	}
};

function smartthing_getIP() {
	var interfaceNameRequested = process.env.HBST_INTERFACE_NAME;

	var myIP = '';
	var ifaces = os.networkInterfaces();
	Object.keys(ifaces).forEach(function (ifname) {
		var alias = 0;
		if (interfaceNameRequested == null || interfaceNameRequested == ifname)
			ifaces[ifname].forEach(function (iface) {
				if ('IPv4' !== iface.family || iface.internal !== false) {
					// skip over internal (i.e. 127.0.0.1) and non-ipv4 addresses
					return;
				}
				myIP = iface.address;
			});
	});
	return myIP;
}
function smartthings_SetupHTTPServer(mySmartThings) {
	//Get the IP address that we will send to the SmartApp. This can be overridden in the config file.

	//Start the HTTP Server
	const server = http.createServer(function (request, response) {
		smartthings_HandleHTTPResponse(request, response, mySmartThings)
	});

	server.listen(mySmartThings.direct_port, (err) => {
		if (err) {
			mySmartThings.log('something bad happened', err);
			return '';
		}
		mySmartThings.log(`Direct Connect Is Listening On ${mySmartThings.direct_ip}:${mySmartThings.direct_port}`);
	})
	return 'good';
}

function smartthings_HandleHTTPResponse(request, response, mySmartThings) {
	if (request.url == '/initial')
		mySmartThings.log("SmartThings Hub Communication Established");
	if (request.url == '/update') {
		var newChange = {
			device: request.headers["change_device"],
			attribute: request.headers["change_attribute"],
			value: request.headers["change_value"],
			date: request.headers["chande_date"]
		};
		mySmartThings.processFieldUpdate(newChange, mySmartThings);
	}
	response.end('OK');
}
