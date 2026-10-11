use serde::Serialize;
use std::fmt;

/// Machine-readable failure. Serialized shape is part of the public agent API:
/// `code` is stable and short, `msg` is one line, `hint` names the fix.
#[derive(Debug, Clone, Serialize)]
pub struct Fail {
    pub code: String,
    pub msg: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hint: Option<String>,
}

impl Fail {
    pub fn new(code: &str, msg: impl Into<String>) -> Self {
        Fail { code: code.to_string(), msg: msg.into(), hint: None }
    }
    pub fn hint(mut self, h: impl Into<String>) -> Self {
        self.hint = Some(h.into());
        self
    }
}

impl fmt::Display for Fail {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.msg)
    }
}

impl std::error::Error for Fail {}

pub type R<T> = Result<T, Fail>;

impl From<std::io::Error> for Fail {
    fn from(e: std::io::Error) -> Self {
        Fail::new("io", e.to_string())
    }
}

impl From<serde_json::Error> for Fail {
    fn from(e: serde_json::Error) -> Self {
        Fail::new("json", e.to_string())
    }
}

impl From<hound::Error> for Fail {
    fn from(e: hound::Error) -> Self {
        Fail::new("wav", e.to_string())
    }
}
