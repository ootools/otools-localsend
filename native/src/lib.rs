pub mod crypto;
pub mod event_bridge;
pub mod models;
pub mod runtime;
pub mod settings;

use serde_json::{json, Value};
use std::panic::{catch_unwind, AssertUnwindSafe};

pub fn handle_json(input: &[u8]) -> Value {
    let request: Value = match serde_json::from_slice(input) {
        Ok(value) => value,
        Err(error) => return json!({"ok": false, "error": format!("invalid request JSON: {error}")}),
    };
    let Some(method) = request.get("method").and_then(Value::as_str).filter(|s| !s.is_empty()) else {
        return json!({"ok": false, "error": "method is required"});
    };
    let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
    match runtime::invoke(method, payload) {
        Ok(data) => json!({"ok": true, "data": data}),
        Err(error) => json!({"ok": false, "error": error}),
    }
}

#[no_mangle]
pub extern "C" fn otools_plugin_invoke(input_ptr: *const u8, input_len: usize, output_len: *mut usize) -> *mut u8 {
    if output_len.is_null() { return std::ptr::null_mut(); }
    let result = catch_unwind(AssertUnwindSafe(|| {
        if input_ptr.is_null() || input_len > isize::MAX as usize {
            json!({"ok": false, "error": "invalid input buffer"})
        } else {
            handle_json(unsafe { std::slice::from_raw_parts(input_ptr, input_len) })
        }
    })).unwrap_or_else(|_| json!({"ok": false, "error": "native plugin panicked"}));
    let bytes = serde_json::to_vec(&result).unwrap_or_else(|_| br#"{"ok":false,"error":"serialization failed"}"#.to_vec()).into_boxed_slice();
    unsafe { *output_len = bytes.len(); }
    Box::into_raw(bytes) as *mut u8
}

#[no_mangle]
pub extern "C" fn otools_plugin_free(ptr: *mut u8, len: usize) {
    if !ptr.is_null() {
        unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len))); }
    }
}
