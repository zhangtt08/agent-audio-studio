pub mod analysis;
pub mod dsp;
pub mod error;
pub mod ff;
pub mod http;
pub mod jobs;
pub mod measure;
pub mod media;
pub mod ops;
pub mod peaks;
pub mod rpc;
pub mod score;
pub mod session;
pub mod stream;
pub mod util;

pub use error::{Fail, R};

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
