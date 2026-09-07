fn main() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/lib");
        println!("cargo:rustc-link-arg=-Wl,-rpath,/usr/lib/swift");
    }
}
