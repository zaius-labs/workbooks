// On non-Windows release builds we keep the standard subsystem;
// on Windows we hide the console so the manager doesn't show a
// stray cmd window when launched from Start Menu.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    workbooks_manager_lib::run();
}
