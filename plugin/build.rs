const COMMANDS: &[&str] = &[
    "pc_create",
    "pc_create_offer",
    "pc_create_answer",
    "pc_set_local",
    "pc_set_remote",
    "pc_add_ice",
    "pc_get_stats",
    "pc_close",
    "pc_upsert_transceiver",
    "pc_request_keyframe",
    "pc_restart_ice",
    "pc_set_transform",
    "pc_audio_processing",
    "media_push",
    "audio_push",
    "dc_create",
    "dc_send",
    "dc_close",
    "dc_buffered_amount",
    "dc_set_threshold",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
