const COMMANDS: &[&str] = &[
    "pc_create",
    "pc_create_offer",
    "pc_create_answer",
    "pc_set_local",
    "pc_set_remote",
    "pc_add_ice",
    "pc_get_stats",
    "pc_close",
    "dc_create",
    "dc_send",
    "dc_close",
    "dc_buffered_amount",
    "dc_set_threshold",
];

fn main() {
    tauri_plugin::Builder::new(COMMANDS).build();
}
