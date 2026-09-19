//! Manages loopback recording (recording system audio output)

use std::{
    ffi::{c_void, CStr},
    mem::MaybeUninit,
    ptr::NonNull,
    sync::atomic::{AtomicU32, Ordering},
};

static AGGREGATE_INSTANCE_COUNTER: AtomicU32 = AtomicU32::new(0);

use objc2::{rc::Retained, AnyThread};
use objc2_core_audio::{
    kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioDevicePropertyDeviceUID,
    kAudioEndPointDeviceIsPrivateKey, kAudioObjectPropertyElementMain,
    kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject, kAudioObjectUnknown,
    kAudioHardwarePropertyTranslatePIDToProcessObject, kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey,
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

        // Exclude our own playback while retaining audio from other apps.
        let process = current_audio_process()?;
        let process_number = process.map(NSNumber::numberWithUnsignedInt);
        let processes = match process_number.as_ref() {
            Some(number) => NSArray::from_slice(&[number.as_ref()]),
            None => NSArray::new(),
        };
        let device_uid = device.uid()?;
        let tap_desc = unsafe {
            CATapDescription::initExcludingProcesses_andDeviceUID_withStream(
                CATapDescription::alloc(),
                &processes,
                device_uid.as_ref(),
                0,
            )
        };
        unsafe {
            let bundle_id = NSString::from_str("local.vietnote.desktop");
            let bundle_ids = NSArray::from_slice(&[bundle_id.as_ref()]);
            tap_desc.setBundleIDs(&bundle_ids);
            tap_desc.setProcessRestoreEnabled(true);
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
