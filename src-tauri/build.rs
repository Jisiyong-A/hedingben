fn main() {
    // iOS：Vision / ImageIO 由 ocr_ios.rs 手工链接（objc2 系 crate 不带框架链接）。
    #[cfg(target_os = "ios")]
    {
        println!("cargo:rustc-link-lib=framework=Foundation");
        println!("cargo:rustc-link-lib=framework=CoreGraphics");
        println!("cargo:rustc-link-lib=framework=ImageIO");
        println!("cargo:rustc-link-lib=framework=Vision");
        println!("cargo:rustc-link-lib=framework=Accelerate");
    }
    tauri_build::build()
}
