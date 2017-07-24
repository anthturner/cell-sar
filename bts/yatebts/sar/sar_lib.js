/** sar_lib.js: engine utility functions for the searchandrescue.js automation
  *
  * Cellular Search and Rescue - Cellular Sensor BTS
  *   Copyright (C) 2017 Microsoft
  * Yet Another Telephony Engine - Base Transceiver Station
  *   Copyright (C) 2013-2014 Null Team Impex SRL
  *   Copyright (C) 2014 Legba, Inc
  * 
  * This file is part of cell-sar/the Yate-BTS Project http://www.yatebts.com
  * 
  * cell-sar is free software: you can redistribute it and/or modify
  * it under the terms of the GNU General Public License as published by
  * the Free Software Foundation, either version 2 of the License, or
  * (at your option) any later version.
  * 
  * cell-sar is distributed in the hope that it will be useful,
  * but WITHOUT ANY WARRANTY; without even the implied warranty of
  * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
  * GNU General Public License for more details.
  * 
  * You should have received a copy of the GNU General Public License
  * along with cell-sar.  If not, see <http://www.gnu.org/licenses/>.
  */

Engine.debugName("searchandrescue");
var onInterval, onPhoneDetected, onPhoneLost, onSendSMS, onSMSReceived, onSignalReceived;

/* ############### Configuration And Variables ############### */
// default values are set here, but could be changed by loadConfiguration

var testing = true;
var loud_sms = false;
var polling_rate = 5;

var country_code = 1;
var nnsf_bits = 8;
var nnsf_node = 123;

var droneRootImsi = "sar_imsi";
var droneRootMsisdn = "1234";

var helloText = "phone detected";

/* ############### Global Variables And Storage ############### */

var sar = SearchAndRescue();

var pendingSMSs = [];
var activeSubscribers = [];

var allowedImsis = {};     // key: IMSI, value: true if allowed
var forbiddenImsis = {};   // key: IMSI, value: true if forbidden

/* ############### Utility Functions ############### */

function describeMsg(msg) {
   for (var key in msg) {
      Engine.debug(Engine.DebugInfo, " - " + key + " -> " + msg[key]);
   }
}

function imsiPermitted(imsi) {
   return (testing && allowedImsis[imsi]) 
      || (!testing && !forbiddenImsis[imsi]);
}

/* ############### SAR Initialization ############### */

var nnsf_node_mask, nnsf_node_shift, nnsf_local_mask;

function loadConfiguration() {
   var conf = new ConfigFile(Engine.configFile('sar'), true);
   if (!conf) return;

   var imsiPattern = new RegExp(/^[0-9]{15}$/);
   var anyAllowedImsis = false;

   for (var section in conf.sections()) {
      if (section === 'general') {
         var general = conf.getSection(section);

         testing = general.getBoolValue('testing', testing);
         loud_sms = general.getBoolValue('loud_sms', loud_sms);
         polling_rate = general.getIntValue('polling_rate', polling_rate);

         country_code = general.getIntValue('country_code', country_code);

         droneRootMsisdn = general.getValue('sensor_phone_number', droneRootMsisdn);

         if (droneRootMsisdn === '911') {
            Engine.alarm(4, "911 is not a permitted phone number for the sensor due to restrictions on use by law enforcement");
         }

         helloText = general.getValue('helloText', helloText);

      } else if (imsiPattern.test(section)) {
         var imsi = section;
         var imsiConfig = conf.getSection(imsi);

         allowedImsis[imsi] = imsiConfig.getBoolValue('allowed');
         forbiddenImsis[imsi] = imsiConfig.getBoolValue('forbidden');

         anyAllowedImsis = anyAllowedImsis || allowedImsis[imsi];
      }
   }

   if (testing && !anyAllowedImsis) {
      Engine.alarm(4, "Testing without any Allowed IMSIs");
   }
}

function initializeSAR() {
   // Initialize NNSF
   if (nnsf_bits > 0 && nnsf_bits <= 10) {
      nnsf_node &= 0x03ff >> (10 - nnsf_bits);
      nnsf_node_mask = (0xffc000 << (10 - nnsf_bits)) & 0xffc000;
      nnsf_node_shift = nnsf_node << (24 - nnsf_bits);
      nnsf_local_mask = 0xffffff >> nnsf_bits;
   } else {
      nnsf_bits = 0;
      nnsf_node = 0;
      nnsf_node_mask = 0;
      nnsf_node_shift = 0;
      nnsf_local_mask = 0xffffff;
   }

   Engine.debug(Engine.DebugInfo, "Loading configuration from sar.conf");
   loadConfiguration();

   // install message handlers and callbacks
   Engine.debug(Engine.DebugInfo, "Installing SAR Listeners");
   Message.install(onAuth, "auth", 80);
   Message.install(onIdleAction, "idle.execute", 110, "module", "sar_cache");
   Message.install(onHandsetRegister, "user.register", 80, 'driver', 'ybts');
   Message.install(onHandsetUnregister, "user.unregister", 80);
   Message.install(onPhyinfo, "phyinfo", 80);
   Message.install(onSMS, "msg.execute", 80, "callto", droneRootImsi); // receives SMSes that are routed to the drone IMSI
   Engine.setInterval(onIntervalSAR, 1000);

   // Ready!
   Engine.debug(Engine.DebugInfo, "Search and Rescue Cell Site is UP! Let's go save some lives.");
}

/* ############### Core SAR Utility and Functionality ############### */

function getSubscriber(imsi, tmsi) {
   for (var i = 0; i < activeSubscribers.length; ++i) {
      if ((!imsi && activeSubscribers[i]["tmsi"] === tmsi) || // Given TMSI but no IMSI
            (!tmsi && activeSubscribers[i]["imsi"] === imsi) || // Given IMSI but no TMSI
            activeSubscribers[i]["imsi"] === imsi) // Given both, use IMSI
      {
         return activeSubscribers[i];
      }
   }

   return null;
}

function allocatePhoneNumber(imsi) {
   if (!imsi)
      var val = country_code + generatePhoneNumber();
   else
      // create number based on IMSI. Try to always generate same number for same IMSI
      var val = country_code + imsi.substr(-7);

   while (!numberAvailable(val))
      val = country_code + generatePhoneNumber();

   return val;
}

function allocateTmsi() {
   var tmsi;

   while (true) {
      if (tmsiAvailable(tmsi = createTmsi()))
         break;
   }

   return tmsi;
}

function tmsiAvailable(tmsi) {
   for (var i = 0; i < activeSubscribers.length; ++i) {
      if (activeSubscribers[i]["tmsi"] === tmsi)
         return false;
   }

   return true;
}

function numberAvailable(number) {
   for (var i = 0; i < activeSubscribers.length; ++i) {
      if (activeSubscribers[i]["msisdn"] === number)
         return false;
   }

   return true;
}

function createTmsi()
{
    var t = last_tmsi;
    if (t)
	    t = 1 * parseInt(t,16);
    else
	    t = 0;

    if (nnsf_bits > 0)
	    t = ((t & 0xff000000) >> nnsf_bits) | (t & nnsf_local_mask);
    t++;

    if (nnsf_bits > 0)
	    t = ((t << nnsf_bits) & 0xff000000) | nnsf_node_shift | (t & nnsf_local_mask);

    if ((t & 0xc0000000) === 0xc0000000)
	    t = nnsf_node_shift + 1;

    return last_tmsi = t.toString(16,8);
}

function generatePduNumber(number) {
   var newNumber = "";
   for (var i = 1; i < number.length; ++i) {
      newNumber += number.charAt(i);
      newNumber += number.charAt(i - 1);
   }
   return newNumber;
}

function generatePhoneNumber() {
   var An = 2 + randomint(8);
   var A = An.toString();
   var Bn = randomint(10);
   var B = Bn.toString();
   var Cn = randomint(10);
   var C = Cn.toString();
   var Dn = randomint(10);
   var D = Dn.toString();
   var En = randomint(10);
   var E = En.toString();

   switch (randomint(25)) {
	// 4 digits in a row - There are 10,000 of each.
	case 0: return A+B+C+D+D+D+D;
	case 1: return A+B+C+C+C+C+D;
	case 2: return A+B+B+B+B+C+D;
	case 3: return A+A+A+A+B+C+D;
	// ABCCBA palidromes - There are about 10,000 of each.
	case 4: return A+B+C+C+B+A+D;
	case 5: return A+B+C+D+D+C+B;
	// ABCABC repeats - There are about 10,000 of each.
	case 6: return A+B+C+A+B+C+D;
	case 7: return A+B+C+D+B+C+D;
	case 8: return A+B+C+D+A+B+C;
	// AABBCC repeats - There are about 10,000 of each.
	case 9: return A+A+B+B+C+C+D;
	case 10: return A+B+B+C+C+D+D;
	// AAABBB repeats - About 1,000 of each.
	case 11: return A+A+A+B+B+B+C;
	case 12: return A+A+A+B+C+C+C;
	case 13: return A+B+B+B+C+C+C;
	// 4-digit straights - There are about 1,000 of each.
	case 14: return "2345"+B+C+D;
	case 15: return "3456"+B+C+D;
	case 16: return "4567"+B+C+D;
	case 17: return "5678"+B+C+D;
	case 18: return "6789"+B+C+D;
	case 19: return A+B+C+"1234";
	case 20: return A+B+C+"2345";
	case 21: return A+B+C+"3456";
	case 22: return A+B+C+"4567";
	case 23: return A+B+C+"5678";
	case 24: return A+B+C+"6789";
   }
}

function enqueueSilentSMS(imsi) {
    var subscriber = getSubscriber(imsi);
    if (!subscriber) return false;
    
    Engine.debug(Engine.DebugInfo, "Sending SilentSMS to IMSI " + imsi);

    var number = subscriber["msisdn"];
    var numberLen = number.length;
    var numberLenHex = numberLen.toString(16);
    if (numberLenHex.length < 2)
        numberLenHex = "0"+numberLenHex;

    // This message is very particular and exploits the "SilentSMS" Class0 'bug' that exists in the SMS signalling protocol
    // 00|01|00|0c|91|214365870921|00|C0|1e|005300650061007200630068002000260020005200650073006300750065
    //     ^     ^               ^     ^  ^                                     `- Message (this is "Search & Rescue")
    //     |     `- Num length   |     |  `- Message length
    //     |                     |     `- Class0 SMS
    // No delivery receipt      Target phone number, pair-swapped

    var pduMessage = "000100" + numberLenHex + "91" + generatePduNumber(number) +
      "00C01e005300650061007200630068002000260020005200650073006300750065";

    var m = new Message("msg.execute");
    m.caller = droneRootImsi;
    m["sms.caller"] = droneRootMsisdn;
    m["rpdu"] = pduMessage;
    m.callto = subscriber["location"];
    m.oimsi = imsi;
    m.otmsi = subscriber["tmsi"];

    m.enqueue();
    return true;
}

function sendSMSMessage(imsi, messageText)
{
   var subscriber = getSubscriber(imsi);
   var sms = {
      'imsi': droneRootImsi,
      'msisdn': droneRootMsisdn,
      'smsc': droneRootMsisdn,
      'dest': subscriber.msisdn,
      'dest_imsi': subscriber.imsi,
      'msg': messageText
   };

   if (!sendSMS(sms)) {
      Engine.debug(Engine.DebugInfo, "Failed to SMS message to IMSI: " + subscriber["imsi"] + ", message was '" + messageText + "'");
   }
}

function sendSMS(sms) {
   // Assume all devices are always online, so we never end up pushing undeliverable messages to the end of the queue
   // May want to change this later, but for now it's a sane approach.

   Engine.debug(Engine.DebugInfo, "Sending SMS to IMSI: " + sms.dest_imsi + " '" + sms.msg + "'");

   var destSubscriber = getSubscriber(sms.dest_imsi);
   if (!destSubscriber) {
      Engine.debug(Engine.DebugInfo, "Did not deliver sms. Unknown dest_imsi: " + sms.dest_imsi);
      return false;
   }
   if (!destSubscriber.location) {
      Engine.debug(Engine.DebugInfo, "Did not deliver sms because destination is offline.");
      return false;
   }

   var m = new Message("msg.execute");
   m.caller = sms.smsc;
   m.called = sms.dest;
   m["sms.caller"] = sms.msisdn;
   if (sms.msisdn.substr(0, 1) === "+") {
      m["sms.caller.nature"] = "international";
      m["sms.caller"] = sms.msisdn.substr(1);
   }
   m.text = sms.msg;
   m.callto = destSubscriber["location"];
   m.oimsi = sms.dest_imsi;
   m.otmsi = destSubscriber["tmsi"];
   m.maxpdd = "5000";
   
   return m.enqueue(); // dispatch seems to lock up yate... not sure why. For now, enqueue seems to work though.
}

function trySendingLater(sms) {
   var now = Date.now() / 1000;
   var later = now + 3; // 3 seconds later
   
   sms.next_try = later;
   if (sms.tries)
      sms.tries -= 1;

   if (sms.tries) {
      pendingSMSs.push(sms);
      return true;
   }

   return false;
}

function sendSilentSMSs() {
   for (var i = 0; i < activeSubscribers.length; i++) {
      var subscriber = activeSubscribers[i];

      if (loud_sms) {
         var text = "Silent SMS #" + subscriber['silentSMSsSent'] + ". ";
         if (subscriber.lastPhyinfo) {
            var phy = subscriber.lastPhyinfo;
            text += "Last Phyinfo: {TA: " + phy.TA + ", TE: " + phy.TE 
               + ", UpRSSI: " + phy.UpRSSI + ", TxPwr: " + phy.TxPwr 
               + ", DnRSSIdBm: " + phy.DnRSSIdBm + ", time: " + phy.time + "}";
         }

         sendSMSMessage(subscriber.imsi, text);

      } else if (!enqueueSilentSMS(subscriber["imsi"])) {
         Engine.debug(Engine.DebugInfo, "Failed to dispatch StealthSMS to IMSI: " + subscriber["imsi"]);
      }

      subscriber['silentSMSsSent'] += 1;
   }
}

function expireSubscriptions(now) {
   // see if we should expire TMSIs
   for (var i = 0; i < activeSubscribers.length; i++)
   {
      if (now >= activeSubscribers[i]["expires"])
      {
         Engine.debug(Engine.DebugInfo, "EXPIRING handset with IMSI '" + activeSubscribers[i]["imsi"] +
            "'. (Expired " + activeSubscribers[i]["expires"] + ")");
         activeSubscribers.splice(i, 1);
         i--;
      }
   }
}

/* ############### Event Handlers and Hooks ############### */

function onAuth(msg) {

	// Auth always succeeds -- this is the weakness in GSM that makes this strategy viable!
	// ----------
	// Due to GSM not authenticating bidirectionally, we can provide dummy cryptographic values
	// to the remote headset and always respond positively to their challenge, rendering any
	// additional phone-oriented security measures useless.
	// ----------
	// - ALT 05/19/2017

   Engine.debug(Engine.DebugInfo, "Authentication successful");

	return true;
}

function onIdleAction() {

   Engine.debug(Engine.DebugInfo, "EXECUTING sar_lib.onIdleAction");

   sendSilentSMSs();

   var now = Date.now()/1000;
   var sms;

   // check if we have any SMSs to send
   for (var i=0; i<pendingSMSs.length; i++) {
      if (pendingSMSs[i].next_try <= now) {
         sms = pendingSMSs[i];
         pendingSMSs.splice(i,1);
         break;
      }
   }

   // if there is one, attempt to send it
   if (sms) {
      var sms_sent = sendSMS(sms);
      if (sms_sent) {
         Engine.debug(Engine.DebugInfo, "Successfully sent SMS to IMSI " + sms.dest_imsi);
         if (onSendSMS) onSendSMS(sms);
      } else {
         if (trySendingLater(sms))
            Engine.debug(Engine.DebugInfo, "Failed to send SMS to IMSI: " + sms.dest_imsi + " - " + sms.msg);
         else
            Engine.debug(Engine.DebugInfo, "Gave up trying to send SMS to IMSI " + sms.dest_imsi + ". Message was '" 
               + sms.msg + "'");
      }
   }

   if (now % 100 < 5) {
      expireSubscriptions(now);
   }

   // Reschedule after 5s
   onIntervalSAR.nextIdle = now + polling_rate;
}

function onHandsetRegister(msg) {
   Engine.debug(Engine.DebugInfo, "ATTEMPTING handset registration for IMSI '" +
      msg.imsi + "' and TMSI '" + msg.tmsi + "'");

   if (!msg.imsi && !msg.tmsi) {
      Engine.debug(Engine.DebugInfo, "FAILED handset registration for IMSI '" +
         msg.imsi + "' and TMSI '" + msg.tmsi + "': Handset not permitted");
      return false;
   }

   if (!msg.imsi) {
      Engine.debug(Engine.DebugInfo, "FAILED handset registration, no IMSI. Asking for one...");
      msg.askimsi = true;
      msg.askimei = true;
      return false;
   }

   // Check for an existing handset with thie IMSI/TMSI
   var subscriber = getSubscriber(msg.imsi, msg.tmsi);
   if (subscriber) {
      // existing handset
      Engine.debug(Engine.DebugInfo, "DUPLICATE handset registration for IMSI '" +
         msg.imsi + "' and TMSI '" + msg.tmsi + "'");
      return true;
   } else {

      var imsi = msg.imsi;
      if (!imsiPermitted(imsi)) {
         Engine.debug(Engine.DebugInfo, "IMSI not allowed");
         return false;
      }

      var tmsi = msg.tmsi;
      if (!tmsi) tmsi = allocateTmsi();

      msg.imsi = imsi;
      msg.tmsi = tmsi;

      var msisdn = allocatePhoneNumber(imsi);
      msg.msisdn = msisdn;
      var expiry = Date.now() / 1000 + 3600 * 24; // 1 day
      var loc = "ybts/TMSI" + tmsi;

      var subscriber = {
         "imsi": imsi,
         "tmsi": tmsi,
         "msisdn": msisdn,
         "expires": expiry,
         "location": loc,
         "silentSMSsSent": 0
      };
      activeSubscribers.push(subscriber);
      if (onPhoneDetected) onPhoneDetected(subscriber);

      var try_time = Date.now() / 1000 + 5; // 5s delay before sending to allow the cell to settle
      pendingSMSs.push({
         "imsi": droneRootImsi,
         "msisdn": droneRootMsisdn,
         "smsc": droneRootMsisdn,
         "dest": msisdn,
         "dest_imsi": imsi,
         "next_try": try_time,
         "tries": 3,
         "msg": helloText
      });

      Engine.debug(Engine.DebugInfo, "SUCCESSFUL handset registration for IMSI '" +
         subscriber.imsi + "' and TMSI '" + subscriber.tmsi + "'");
      return true;
   }
}

function onHandsetUnregister(msg) {
   Engine.debug(Engine.DebugInfo, "ATTEMPTING to unregister IMSI '" +
      msg.imsi + "' and TMSI '" + msg.tmsi + "'");
   var subscriber = getSubscriber(msg.imsi, msg.tmsi);

   if (subscriber) {

      var idx = activeSubscribers.indexOf(subscriber);
      activeSubscribers.splice(idx, 1);
      Engine.debug(Engine.DebugInfo, "SUCCESSFUL handset unregistration for IMSI '" +
         subscriber["imsi"] + "' and TMSI '" + subscriber["tmsi"] + "'");

      if (onPhoneLost) onPhoneLost(subscriber);

   } else {
      Engine.debug(Engine.DebugInfo, "NOT FOUND handset unregistration for IMSI '" +
         subscriber["imsi"] + "' and TMSI '" + subscriber["tmsi"] + "'");
   }
}

function onPhyinfo(msg) {

   // check if a valid subscriber
   var subscriber = getSubscriber(msg.IMSI, msg.TMSI);
   if (subscriber === null) {
      Engine.debug(Engine.DebugInfo, "Unknown subscriber with IMSI: " + msg.IMSI + " and TMSI " + msg.TMSI);
      return true;
   }

   // call the searchandrescue C++ module
   sar.writePhyinfo(subscriber['imsi'], subscriber['tmsi'], 
      msg.TA, msg.TE, msg.UpRSSI, msg.TxPwr, msg.DnRSSIdBm, msg.time);

   // update the subscriber's phyinfo
   subscriber.lastPhyinfo = {
      'TA': msg.TA,
      'TE': msg.TE,
      'UpRSSI': msg.UpRSSI,
      'TxPwr': msg.TxPwr,
      'DnRSSIdBm': msg.DnRSSIdBm,
      'time': msg.time
   };

   if (onSignalReceived) 
      onSignalReceived(subscriber, msg.TA, msg.TE, msg.UpRSSI, msg.TxPwr, msg.DnRSSIdBm, msg.time);

   return true;
}

function onSMS(msg) {
   Engine.debug(Engine.DebugInfo, "Got SMS from IMSI " + msg.imsi + " - '" 
      + msg.text + "'");

   if (onSMSReceived) onSMSReceived(msg);
}

function onIntervalSAR() {
   var when = Date.now() / 1000;
   if (onIntervalSAR.nextIdle >= 0 && when >= onIntervalSAR.nextIdle) {
      onIntervalSAR.nextIdle = -1;
      var m = new Message("idle.execute");
      m.module = "sar_cache";
      if (!m.enqueue())
         onIntervalSAR.nextIdle = when + 5;
   }

   // client's interval action
   if (onInterval) onInterval();
}
