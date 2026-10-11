//! Manages loopback recording (recording system audio output)

use std::{
    ffi::{c_void, CStr},
    mem::MaybeUninit,
    ptr::NonNull,
    sync::{
        atomic::{AtomicU32, Ordering},
        Mutex, Once,
    },
    time::Duration,
};

static AGGREGATE_INSTANCE_COUNTER: AtomicU32 = AtomicU32::new(0);

use objc2::{rc::Retained, runtime::NSObjectProtocol, sel, AnyThread};
use objc2_core_audio::{
    kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID,
    kAudioEndPointDeviceIsPrivateKey, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioObjectUnknown,
    kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
    kAudioHardwarePropertyProcessObjectList, kAudioProcessPropertyBundleID, kAudioProcessPropertyIsRunningOutput,
    kAudioProcessPropertyPID, kAudioTapPropertyDescription, AudioObjectGetPropertyDataSize, AudioObjectSetPropertyData,
    AudioHardwareCreateAggregateDevice, AudioHardwareCreateProcessTap,
    AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress, CATapDescription,
    CATapMuteBehavior,
};
use objc2_core_foundation::{
    kCFAllocatorDefault, kCFTypeArrayCallBacks, kCFTypeDictionaryKeyCallBacks,
    kCFTypeDictionaryValueCallBacks, CFArray, CFDictionary, CFMutableDictionary, CFRetained,
    CFString,
};
use objc2_foundation::{NSArray, NSNumber, NSString};

use super::device::Device;
use crate::{host::coreaudio::check_os_status, Error, ErrorKind};
type CFStringRef = *mut std::os::raw::c_void;

impl Device {
    #[allow(dead_code)]
    fn uid(&self) -> Result<Retained<NSString>, Error> {
        let mut cfstring: CFStringRef = std::ptr::null_mut();
        let mut size = std::mem::size_of::<CFStringRef>() as u32;

        let property = AudioObjectPropertyAddress {
            mSelector: kAudioDevicePropertyDeviceUID,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };

        let status = unsafe {
            AudioObjectGetPropertyData(
                self.audio_device_id,
                NonNull::from(&property),
                0,
                std::ptr::null(),
                NonNull::from(&mut size),
                NonNull::from(&mut cfstring).cast(),
            )
        };
        check_os_status(status)?;

        if cfstring.is_null() {
            return Err(ErrorKind::DeviceNotAvailable.into());
        }

        let ns_string: Retained<NSString> = unsafe {
            // unwrap cause cfstring!=null as checked before
            Retained::retain(cfstring as *mut NSString).unwrap()
        };

        Ok(ns_string)
    }
}

// VietNote plays translated speech in the same app that captures system audio.
// Core Audio identifies process taps by AudioObjectID, not by Unix PID. Resolve
// the current process when possible; the bundle ID below also covers the case
// where the audio process has not connected to Core Audio yet at tap creation.
fn current_audio_process() -> Result<Option<AudioObjectID>, Error> {
    let pid = std::process::id() as i32;
    let mut process: AudioObjectID = kAudioObjectUnknown as AudioObjectID;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let property = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&property),
            std::mem::size_of::<i32>() as u32,
            &pid as *const i32 as *const c_void,
            NonNull::from(&mut size),
            NonNull::from(&mut process).cast(),
        )
    };
    check_os_status(status)?;
    Ok((process != kAudioObjectUnknown as AudioObjectID).then_some(process))
}

/// Apps left out of system-audio capture, by bundle ID. A process matches its app's ID or one
/// below it, so `com.google.Chrome` also covers `com.google.Chrome.helper`, which plays the tabs.
static EXCLUDED_APPS: Mutex<Vec<String>> = Mutex::new(Vec::new());
/// Running taps, so a changed list (or an app that starts playing later) applies mid-recording.
static LIVE_TAPS: Mutex<Vec<LiveTap>> = Mutex::new(Vec::new());
static WATCHER: Once = Once::new();

struct LiveTap {
    id: AudioObjectID,
    description: Retained<CATapDescription>,
    excluded: Vec<AudioObjectID>,
}
// Only touched under LIVE_TAPS; the description's properties are atomic.
unsafe impl Send for LiveTap {}

/// A process Core Audio knows about, as listed by [`audio_processes`].
#[derive(Clone, Debug)]
pub struct AudioProcess {
    pub pid: i32,
    pub bundle_id: String,
    /// Sending sound to an output right now.
    pub playing: bool,
}

/// Every process connected to Core Audio, with its bundle ID (empty for plain binaries).
pub fn audio_processes() -> Vec<AudioProcess> {
    process_objects()
        .into_iter()
        .filter_map(|object| {
            Some(AudioProcess {
                pid: process_value::<i32>(object, kAudioProcessPropertyPID)?,
                bundle_id: process_bundle_id(object).unwrap_or_default(),
                playing: process_value::<u32>(object, kAudioProcessPropertyIsRunningOutput).unwrap_or(0) != 0,
            })
        })
        .collect()
}

/// Leaves these apps (bundle IDs) out of system-audio capture, including recordings already running.
pub fn set_excluded_apps(apps: Vec<String>) {
    *EXCLUDED_APPS.lock().unwrap_or_else(|e| e.into_inner()) = apps;
    refresh_taps();
}

fn excluded_apps_match(bundle_id: &str, apps: &[String]) -> bool {
    apps.iter().any(|app| bundle_id == app || bundle_id.strip_prefix(app.as_str()).is_some_and(|rest| rest.starts_with('.')))
}

/// Our own process and every process of an excluded app, as Core Audio object IDs.
fn excluded_process_objects() -> Vec<AudioObjectID> {
    let apps = EXCLUDED_APPS.lock().unwrap_or_else(|e| e.into_inner()).clone();
    let own = std::process::id() as i32;
    let mut objects: Vec<AudioObjectID> = process_objects()
        .into_iter()
        .filter(|&object| {
            process_value::<i32>(object, kAudioProcessPropertyPID) == Some(own)
                || (!apps.is_empty() && process_bundle_id(object).is_some_and(|id| excluded_apps_match(&id, &apps)))
        })
        .collect();
    objects.sort_unstable();
    objects
}

fn ns_numbers(objects: &[AudioObjectID]) -> Retained<NSArray<NSNumber>> {
    let numbers: Vec<Retained<NSNumber>> = objects.iter().map(|&id| NSNumber::numberWithUnsignedInt(id)).collect();
    NSArray::from_retained_slice(&numbers)
}

/// Points every running tap at the current exclusions. Apps open new audio processes as they go
/// (a browser tab starting a video), so a watcher calls this every second while taps run.
fn refresh_taps() {
    let mut taps = LIVE_TAPS.lock().unwrap_or_else(|e| e.into_inner());
    if taps.is_empty() {
        return;
    }
    let excluded = excluded_process_objects();
    for tap in taps.iter_mut().filter(|tap| tap.excluded != excluded) {
        let property = AudioObjectPropertyAddress {
            mSelector: kAudioTapPropertyDescription,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain,
        };
        unsafe { tap.description.setProcesses(&ns_numbers(&excluded)) };
        let pointer: *const CATapDescription = &*tap.description;
        let status = unsafe {
            AudioObjectSetPropertyData(
                tap.id,
                NonNull::from(&property),
                0,
                std::ptr::null(),
                std::mem::size_of::<*const CATapDescription>() as u32,
                NonNull::from(&pointer).cast(),
            )
        };
        if status == 0 {
            tap.excluded = excluded.clone();
        }
    }
}

fn watch_taps() {
    WATCHER.call_once(|| {
        std::thread::Builder::new()
            .name("cpal-tap-exclusions".into())
            .spawn(|| loop {
                std::thread::sleep(Duration::from_secs(1));
                refresh_taps();
            })
            .ok();
    });
}

fn process_objects() -> Vec<AudioObjectID> {
    let property = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyProcessObjectList,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let system = kAudioObjectSystemObject as AudioObjectID;
    let mut size = 0u32;
    let status = unsafe { AudioObjectGetPropertyDataSize(system, NonNull::from(&property), 0, std::ptr::null(), NonNull::from(&mut size)) };
    if status != 0 || size == 0 {
        return Vec::new();
    }
    let mut objects = vec![0 as AudioObjectID; size as usize / std::mem::size_of::<AudioObjectID>()];
    let status = unsafe {
        AudioObjectGetPropertyData(system, NonNull::from(&property), 0, std::ptr::null(), NonNull::from(&mut size), NonNull::new(objects.as_mut_ptr()).unwrap().cast())
    };
    if status != 0 {
        return Vec::new();
    }
    objects.truncate(size as usize / std::mem::size_of::<AudioObjectID>());
    objects
}

fn process_value<T: Copy + Default>(object: AudioObjectID, selector: u32) -> Option<T> {
    let property = AudioObjectPropertyAddress { mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain };
    let mut value = T::default();
    let mut size = std::mem::size_of::<T>() as u32;
    let status = unsafe { AudioObjectGetPropertyData(object, NonNull::from(&property), 0, std::ptr::null(), NonNull::from(&mut size), NonNull::from(&mut value).cast()) };
    (status == 0).then_some(value)
}

fn process_bundle_id(object: AudioObjectID) -> Option<String> {
    let property = AudioObjectPropertyAddress {
        mSelector: kAudioProcessPropertyBundleID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut cfstring: CFStringRef = std::ptr::null_mut();
    let mut size = std::mem::size_of::<CFStringRef>() as u32;
    let status = unsafe { AudioObjectGetPropertyData(object, NonNull::from(&property), 0, std::ptr::null(), NonNull::from(&mut size), NonNull::from(&mut cfstring).cast()) };
    if status != 0 || cfstring.is_null() {
        return None;
    }
    // The HAL hands over a +1 reference.
    let string: Retained<NSString> = unsafe { Retained::from_raw(cfstring as *mut NSString)? };
    let id = string.to_string();
    (!id.is_empty()).then_some(id)
}

/// An aggregate device with tap for recording system output.
///
/// Its main difference with [`Device`] is that it's destroyed when dropped.
///
/// It also doesn't implement the [`DeviceTrait`] as users shouldn't be using it. Its
/// main purpose is to destroy the created aggregate device when loopback recording
/// is done.
#[derive(PartialEq, Eq)]
pub struct LoopbackDevice {
    pub tap_id: AudioObjectID,
    pub aggregate_device: Device,
}

impl LoopbackDevice {
    /// Create a [`LoopbackDevice`] that records the sound
    /// output of `device`.
    pub fn from_device(device: &Device) -> Result<Self, Error> {
        // 1 - Create tap

        let pid = std::process::id();
        let instance = AGGREGATE_INSTANCE_COUNTER.fetch_add(1, Ordering::Relaxed);

        // Exclude our own playback, and any app the user left out, while keeping other apps.
        let mut excluded = excluded_process_objects();
        if let Some(process) = current_audio_process()? {
            if !excluded.contains(&process) {
                excluded.push(process);
                excluded.sort_unstable();
            }
        }
        let processes = ns_numbers(&excluded);
        // A global tap follows whatever the system plays to, so audio keeps coming when
        // the output switches mid-recording (AirPods connecting, speakers taking over).
        // A tap bound to the device's UID goes silent as soon as another device is used.
        let _ = device;
        let tap_desc = unsafe {
            CATapDescription::initStereoGlobalTapButExcludeProcesses(
                CATapDescription::alloc(),
                &processes,
            )
        };
        unsafe {
            // bundleIDs and processRestoreEnabled arrived in macOS 26; older systems would throw on
            // the unknown selector. The process list above covers them there.
            if tap_desc.respondsToSelector(sel!(setBundleIDs:)) {
                let bundle_id = NSString::from_str("local.vietnote.desktop");
                let bundle_ids = NSArray::from_slice(&[bundle_id.as_ref()]);
                tap_desc.setBundleIDs(&bundle_ids);
            }
            if tap_desc.respondsToSelector(sel!(setProcessRestoreEnabled:)) {
                tap_desc.setProcessRestoreEnabled(true);
            }
            tap_desc.setMuteBehavior(CATapMuteBehavior::Unmuted); // captured audio still goes to speakers
            tap_desc.setName(&NSString::from_str(&format!(
                "cpal output recorder {pid}.{instance}"
            )));
            tap_desc.setPrivate(true); // the Aggregate Device would be private
            tap_desc.setExclusive(true); // the process list means exclude them
        };

        let mut tap_obj_id: MaybeUninit<AudioObjectID> = MaybeUninit::uninit();
        let tap_obj_id = unsafe {
            let status =
                AudioHardwareCreateProcessTap(Some(tap_desc.as_ref()), tap_obj_id.as_mut_ptr());
            check_os_status(status)?;
            tap_obj_id.assume_init()
        };
        let tap_uid = unsafe { tap_desc.UUID().UUIDString() };
        LIVE_TAPS.lock().unwrap_or_else(|e| e.into_inner()).push(LiveTap { id: tap_obj_id, description: tap_desc.clone(), excluded });
        watch_taps();

        // 2 - Create aggregate device
        let aggregate_device_properties = create_audio_aggregate_device_properties(
            tap_uid,
            &format!("com.cpal.LoopbackRecordAggregateDevice.{pid}.{instance}"),
            &format!("Cpal loopback aggregate {pid}.{instance}"),
        );
        let mut aggregate_device_id: AudioObjectID = 0;
        let status = unsafe {
            AudioHardwareCreateAggregateDevice(
                aggregate_device_properties.as_ref(),
                NonNull::from(&mut aggregate_device_id),
            )
        };
        check_os_status(status)?;

        Ok(Self {
            tap_id: tap_obj_id,
            aggregate_device: Device::new(aggregate_device_id),
        })
    }
}

impl Drop for LoopbackDevice {
    fn drop(&mut self) {
        LIVE_TAPS.lock().unwrap_or_else(|e| e.into_inner()).retain(|tap| tap.id != self.tap_id);
        unsafe {
            // We don't check status to avoid panic during `drop`
            let _status =
                AudioHardwareDestroyAggregateDevice(self.aggregate_device.audio_device_id);
            let _status = AudioHardwareDestroyProcessTap(self.tap_id);
        }
    }
}

fn to_cfstring(cstr: &'static CStr) -> CFRetained<CFString> {
    unsafe {
        CFString::with_c_string(
            kCFAllocatorDefault,
            cstr.as_ptr(),
            0x08000100, /* UTF8 */
        )
    }
    .unwrap()
}

/// Rust reimplementation of the following:
/// ```c
/// tap_uid = [[tap_description UUID] UUIDString];
/// taps = @[
///     @{
///         @kAudioSubTapUIDKey : (NSString*)tap_uid,
///         @kAudioSubTapDriftCompensationKey : @YES,
///     },
/// ];
///
/// aggregate_device_properties = @{
///     @kAudioAggregateDeviceNameKey : @"MiniMetersAggregateDevice",
///     @kAudioAggregateDeviceUIDKey :
///         @"com.josephlyncheski.MiniMetersAggregateDevice",
///     @kAudioAggregateDeviceTapListKey : taps,
///     @kAudioAggregateDeviceTapAutoStartKey : @YES,
///     @kAudioAggregateDeviceIsPrivateKey : @YES,
/// };
/// ```
pub fn create_audio_aggregate_device_properties(
    tap_uid: Retained<NSString>,
    agg_uid: &str,
    agg_name: &str,
) -> CFRetained<CFDictionary> {
    let tap_inner = unsafe {
        let dict = CFMutableDictionary::new(
            kCFAllocatorDefault,
            2,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();

        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapUIDKey) as *const _ as *const c_void,
            &*tap_uid as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioSubTapDriftCompensationKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );

        dict
    };
    let _taps_list = [tap_inner];
    let taps = unsafe {
        CFArray::new(
            kCFAllocatorDefault,
            _taps_list.as_ptr() as *mut *const c_void,
            _taps_list.len() as _,
            &kCFTypeArrayCallBacks,
        )
        .unwrap()
    };
    let aggregate_dev_properties = unsafe {
        let dict = CFMutableDictionary::new(
            kCFAllocatorDefault,
            5,
            &kCFTypeDictionaryKeyCallBacks,
            &kCFTypeDictionaryValueCallBacks,
        )
        .unwrap();

        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceNameKey) as *const _ as *const c_void,
            &*CFString::from_str(agg_name) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceUIDKey) as *const _ as *const c_void,
            &*CFString::from_str(agg_uid) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceTapListKey) as *const _ as *const c_void,
            &*taps as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioAggregateDeviceTapAutoStartKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );
        CFMutableDictionary::set_value(
            Some(dict.as_ref()),
            &*to_cfstring(kAudioEndPointDeviceIsPrivateKey) as *const _ as *const c_void,
            &*NSNumber::initWithBool(NSNumber::alloc(), true) as *const _ as *const c_void,
        );

        CFRetained::cast_unchecked::<CFDictionary>(dict)
    };

    aggregate_dev_properties
}
