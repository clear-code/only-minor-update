/*
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
*/

// see http://mxr.mozilla.org/mozilla-central/source/toolkit/mozapps/update/nsUpdateService.js

const ID = 'only-minor-update@clear-code.com';

const Cc = Components.classes;
const Ci = Components.interfaces;
const Cu = Components.utils;
const Cr = Components.results;
Cu.import('resource://gre/modules/XPCOMUtils.jsm');
Cu.import('resource://gre/modules/Services.jsm');
Cu.import('resource://gre/modules/ctypes.jsm');
Cu.import('resource://gre/modules/Timer.jsm');

const kCID  = Components.ID('{714fb150-50f3-11e3-8f96-0800200c9a66}'); 
const kID   = '@clear-code.com/only-minor-update/provider;1';
const kNAME = 'MinorUpdateProviderService';

const CACHE_LIFETIME = 30 * 60 * 1000; // 30min in milliseconds

switch (Services.appinfo.name) {
  case 'Firefox':
    XPCOMUtils.defineLazyServiceGetter(this, 'Application',
      '@mozilla.org/fuel/application;1', 'fuelIApplication');
    break;
  case 'Thunderbird':
    XPCOMUtils.defineLazyServiceGetter(this, 'Application',
      '@mozilla.org/steel/application;1', 'steelIApplication');
    break;
}

function log(aMessage) {
  if (this.Application)
    Application.console.log(aMessage);
  else
    Cu.reportError(new Error(aMessage));
}

XPCOMUtils.defineLazyModuleGetter(this, 'UpdateChannel',
                                  'resource://gre/modules/UpdateChannel.jsm');

XPCOMUtils.defineLazyGetter(this, 'gABI', function() {
  let abi = null;
  try {
    abi = Services.appinfo.XPCOMABI;
  }
  catch(error) {
    Cu.reportError(error);
  }
  if (Services.appinfo.OS == 'Darwin') {
    let macutils = Cc['@mozilla.org/xpcom/mac-utils;1'].
                   getService(Ci.nsIMacUtils);
    if (macutils.isUniversalBinary)
      abi += '-u-' + macutils.architecturesInBinary;
/*
  #ifdef MOZ_SHARK
    // Disambiguate optimised and shark nightlies
    abi += '-shark'
  #endif
*/
  }
  return abi;
});

XPCOMUtils.defineLazyGetter(this, 'gOSVersion', function() {
  let osVersion;
  let sysInfo = Cc['@mozilla.org/system-info;1'].
                getService(Ci.nsIPropertyBag2);
  try {
    osVersion = sysInfo.getProperty('name') + ' ' + sysInfo.getProperty('version');
  }
  catch(error) {
    Cu.reportError(error);
  }

  if (osVersion) {
    if (Services.appinfo.OS == 'WINNT') {
      const BYTE = ctypes.uint8_t;
      const WORD = ctypes.uint16_t;
      const DWORD = ctypes.uint32_t;
      const WCHAR = ctypes.jschar;
      const BOOL = ctypes.int;

      // This structure is described at:
      // http://msdn.microsoft.com/en-us/library/ms724833%28v=vs.85%29.aspx
      const SZCSDVERSIONLENGTH = 128;
      const OSVERSIONINFOEXW = new ctypes.StructType('OSVERSIONINFOEXW',
          [
          {dwOSVersionInfoSize: DWORD},
          {dwMajorVersion: DWORD},
          {dwMinorVersion: DWORD},
          {dwBuildNumber: DWORD},
          {dwPlatformId: DWORD},
          {szCSDVersion: ctypes.ArrayType(WCHAR, SZCSDVERSIONLENGTH)},
          {wServicePackMajor: WORD},
          {wServicePackMinor: WORD},
          {wSuiteMask: WORD},
          {wProductType: BYTE},
          {wReserved: BYTE}
          ]);

      // This structure is described at:
      // http://msdn.microsoft.com/en-us/library/ms724958%28v=vs.85%29.aspx
      const SYSTEM_INFO = new ctypes.StructType('SYSTEM_INFO',
          [
          {wProcessorArchitecture: WORD},
          {wReserved: WORD},
          {dwPageSize: DWORD},
          {lpMinimumApplicationAddress: ctypes.voidptr_t},
          {lpMaximumApplicationAddress: ctypes.voidptr_t},
          {dwActiveProcessorMask: DWORD.ptr},
          {dwNumberOfProcessors: DWORD},
          {dwProcessorType: DWORD},
          {dwAllocationGranularity: DWORD},
          {wProcessorLevel: WORD},
          {wProcessorRevision: WORD}
          ]);

      let kernel32 = false;
      try {
        kernel32 = ctypes.open('Kernel32');
      } catch(error) {
        Cu.reportError(error);
        osVersion += '.unknown (unknown)';
      }

      if (kernel32) {
        try {
          // Get Service pack info
          try {
            let GetVersionEx = kernel32.declare('GetVersionExW',
                                                ctypes.default_abi,
                                                BOOL,
                                                OSVERSIONINFOEXW.ptr);
            let winVer = OSVERSIONINFOEXW();
            winVer.dwOSVersionInfoSize = OSVERSIONINFOEXW.size;

            if (0 !== GetVersionEx(winVer.address())) {
              osVersion += '.' + winVer.wServicePackMajor
                        +  '.' + winVer.wServicePackMinor;
            }
            else {
              Cu.reportError(new ERror('gOSVersion - Unknown failure in GetVersionEX (returned 0)'));
              osVersion += '.unknown';
            }
          }
          catch(error) {
            Cu.reportError(error);
            osVersion += '.unknown';
          }

          // Get processor architecture
          let arch = 'unknown';
          try {
            let GetNativeSystemInfo = kernel32.declare('GetNativeSystemInfo',
                                                       ctypes.default_abi,
                                                       ctypes.void_t,
                                                       SYSTEM_INFO.ptr);
            let sysInfo = SYSTEM_INFO();
            // Default to unknown
            sysInfo.wProcessorArchitecture = 0xffff;

            GetNativeSystemInfo(sysInfo.address());
            switch (sysInfo.wProcessorArchitecture) {
              case 9:
                arch = 'x64';
                break;
              case 6:
                arch = 'IA64';
                break;
              case 0:
                arch = 'x86';
                break;
            }
          }
          catch(error) {
            Cu.reportError(error);
          }
          finally {
            osVersion += ' (' + arch + ')';
          }
        } finally {
          kernel32.close();
        }
      }
    }

    try {
      osVersion += ' (' + sysInfo.getProperty('secondaryLibrary') + ')';
    }
    catch(e) {
      // Not all platforms have a secondary widget library, so an error is nothing to worry about.
    }
    osVersion = encodeURIComponent(osVersion);
  }
  return osVersion;
});

function readStringFromInputStream(inputStream) {
  var sis = Cc['@mozilla.org/scriptableinputstream;1'].
            createInstance(Ci.nsIScriptableInputStream);
  sis.init(inputStream);
  var text = sis.read(sis.available());
  sis.close();
  if (text[text.length - 1] == '\n')
    text = text.slice(0, -1);
  return text;
}

var gLocale = null;
function getLocale() {
  if (gLocale)
    return gLocale;

  for each (res in ['app', 'gre']) {
    var channel = Services.io.newChannel('resource://' + res + '/update.locale', null, null);
    try {
      var inputStream = channel.open();
      gLocale = readStringFromInputStream(inputStream);
    } catch(e) {}
    if (gLocale)
      break;
  }

  if (!gLocale)
    throw Components.Exception('update.locale file doesn\'t exist in ' +
                               'either the application or GRE directories',
                               Cr.NS_ERROR_FILE_NOT_FOUND);
  return gLocale;
}

function getDistributionPrefValue(aPrefName) {
  var prefValue = 'default';
  try {
    prefValue = Services.prefs.getDefaultBranch(null).getCharPref(aPrefName);
  }
  catch(error) {
  }
  return prefValue;
}

function MinorUpdateProvider() { 
}
MinorUpdateProvider.prototype = {
  observe: function(aSubject, aTopic, aData) {
    switch (aTopic) {
      case 'profile-after-change':
        return this.init();
      case 'update-check-start':
        return this.onUpdate();
    }
  },

  get updateInfoFile() {
    if (!this._updateInfoFile) {
      this._updateInfoFile = Services.dirsvc.get('ProfD', Ci.nsIFile);
      this._updateInfoFile.append('update.xml');
    }
    return this._updateInfoFile;
  },
  _updateInfoFile: null,

  get updateInfoFileURL() {
    if (!this._updateInfoFileURL)
      this._updateInfoFileURL = Services.io.newFileURI(this.updateInfoFile);
    return this._updateInfoFileURL;
  },
  _updateInfoFileURL: null,

  get shouldDownload() {
    if (!this.updateInfoFile.exists())
      return true;

    return Date.now() - this.updateInfoFile.lastModifiedTime >= CACHE_LIFETIME;
  },

  get defaultUpdateURI() {
    if (this._defaultUpdateURI)
      return this._defaultUpdateURI;

    var defaultBranch = Services.prefs.getDefaultBranch(null);
    var uriString = defaultBranch.getComplexValue('app.update.url', Ci.nsISupportsString);

    var spec = uriString.data;
    spec = spec.replace(/%PRODUCT%/g, Services.appinfo.name);
    spec = spec.replace(/%VERSION%/g, Services.appinfo.version);
    spec = spec.replace(/%BUILD_ID%/g, Services.appinfo.appBuildID);
    spec = spec.replace(/%BUILD_TARGET%/g, Services.appinfo.OS + '_' + gABI);
    spec = spec.replace(/%OS_VERSION%/g, gOSVersion);
    if (/%LOCALE%/.test(spec))
      spec = spec.replace(/%LOCALE%/g, getLocale());
    spec = spec.replace(/%CHANNEL%/g, UpdateChannel.get());
    spec = spec.replace(/%PLATFORM_VERSION%/g, Services.appinfo.platformVersion);
    spec = spec.replace(/%DISTRIBUTION%/g,
                        getDistributionPrefValue('distribution.id'));
    spec = spec.replace(/%DISTRIBUTION_VERSION%/g,
                        getDistributionPrefValue('distribution.version'));
    spec = spec.replace(/\+/g, '%2B');

    spec += (spec.indexOf('?') != -1 ? '&' : '?') + 'force=1';

    return this._defaultUpdateURI = Services.io.newURI(spec, 'UTF-8', null);
  },

  init: function() {
    Services.obs.addObserver(this, 'update-check-start', false);
    this.overrideUpdateURL();

    if (this.updateInfoFile.exists())
      this.updateInfoFile.remove(true);
  },

  overrideUpdateURL: function() {
    var updateInfoURL = Services.io.newFileURI(this.updateInfoFile);
    try {
      var current = Services.prefs.getComplexValue('app.update.url.override', Ci.nsISupportsString);
      if (current.data == updateInfoURL.spec)
        return;
    }
    catch(error) {
      Cu.reportError(error);
    }

    var updateInfoURLString = Cc['@mozilla.org/supports-string;1'].createInstance(Ci.nsISupportsString);
    updateInfoURLString.data = updateInfoURL.spec;
    Services.prefs.setComplexValue('app.update.url.override', Ci.nsISupportsString, updateInfoURLString);
  },

  onUpdate: function() {
    log('onUpdate: shouldDownload = ' + this.shouldDownload);
    if (!this.shouldDownload)
      return;

    this.updateCachedUpdateInfo((function() {
      try {
        var currentMajorVersion = Services.appinfo.version.split('.')[0];
        var updateVersion = this.getUpdateVersion();
        log('Trying update: ' + Services.appinfo.version + ' => ' + updateVersion);
        var updateMajorVersion = updateVersion.split('.')[0];
        log('major version: ' + currentMajorVersion + ' => ' + updateMajorVersion);
        if (currentMajorVersion == updateMajorVersion)
          this.retryUpdate();
      }
      catch(error) {
        Cu.reportError(error);
      }
      finally {
        setTimeout((function() {
          this.updateInfoFile.remove(true);
        }).bind(this), 5000);
      }
    }).bind(this));
  },

  updateCachedUpdateInfo: function(aCallback) {
    var source = this.defaultUpdateURI;
    var destination = this.updateInfoFile;
    log('updateCachedUpdateInfo: ' + source.spec + ' => ' + destination.path);
    var self = this;
    var persist = Cc['@mozilla.org/embedding/browser/nsWebBrowserPersist;1']
                   .createInstance(Ci.nsIWebBrowserPersist);
    persist.persistFlags = Ci.nsIWebBrowserPersist.PERSIST_FLAGS_REPLACE_EXISTING_FILES |
                           Ci.nsIWebBrowserPersist.PERSIST_FLAGS_AUTODETECT_APPLY_CONVERSION;
    persist.progressListener = {
      onProgressChange: function(aWebProgress, aRequest,
                                 aCurSelfProgress, aMaxSelfProgress,
                                 aCurTotalProgress, aMaxTotalProgress) {
        var percentage = Math.round((aCurTotalProgress / aMaxTotalProgress) * 100);
        if (percentage < 100)
          return;

        var delay = 100;
        setTimeout(function delayedCallback() {
          if (!self.updateInfoFile.exists()) {
            return setTimeout(delayedCallback, delay);
          }
          aCallback();
        }, delay);
      },
      onStateChange: function(aWebProgress, aRequest, aStateFlags, aStatus) {
      }
    };
    persist.saveURI(source, null, null, null, null, destination, null);
  },

  getUpdateVersion: function() {
    var stream = Cc['@mozilla.org/network/file-input-stream;1']
                  .createInstance(Ci.nsIFileInputStream);
    stream.init(this.updateInfoFile, 1, 0, false);
    var updateInfoXMLString = readStringFromInputStream(stream);
    stream.close();

    var DOMParser = Cc['@mozilla.org/xmlextras/domparser;1']
                     .createInstance(Ci.nsIDOMParser);
    var updateInfoXML = DOMParser.parseFromString(updateInfoXMLString, 'text/xml');

    var updates = updateInfoXML.documentElement.childNodes;
    for (let i = 0, maxi = updates.length; i < maxi; i++) {
      let update = updates[i];
      if (update.nodeType != Ci.nsIDOMNode.ELEMENT_NODE)
        continue;
      let version = update.getAttribute('appVersion');
      if (version)
        return version;
    }
    return '';
  },

  retryUpdate: function() {
    var browserAboutDialog = Services.wm.getMostRecentWindow('Browser:About');
    var mailAboutDialog = Services.wm.getMostRecentWindow('Mail:About');
    var aboutDialog = browserAboutDialog || mailAboutDialog;
    if (aboutDialog) {
      let opener = aboutDialog.opener;
      let url = aboutDialog.location.href;
      aboutDialog.close();

      let features;
      switch (Services.appinfo.OS) {
        case 'WINNT':
          features = 'chrome,centerscreen,dependent';
          break;
        case 'Darwin':
          features = 'chrome,resizable=no,minimizable=no';
          break;
        default: // Linux
          features = 'chrome,centerscreen,dependent,dialog=no';
          break;
      }
      Services.ww.openWindow(opener, url, '', features, null);
    }
    else {
      let US = Cc['@mozilla.org/updates/update-service;1']
                .getService(Ci.nsIApplicationUpdateService);
      US.backgroundChecker.checkForUpdates(US, true);
    }
  },

  classID: kCID,
  contractID: kID,
  classDescription: kNAME,
  QueryInterface: XPCOMUtils.generateQI([Ci.nsIObserver]),
  _xpcom_categories: [
    { category : 'profile-after-change', service : true }
  ]
};

var NSGetFactory = XPCOMUtils.generateNSGetFactory([MinorUpdateProvider]);
