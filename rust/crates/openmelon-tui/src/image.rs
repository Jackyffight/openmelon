use std::fs;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use base64::Engine;
use reqwest::blocking::Client;
use serde::Deserialize;

#[derive(Debug, Clone)]
pub struct ImageGenerator {
    provider: String,
    api_key: String,
    base_url: String,
    model: String,
    client: Client,
}

pub struct ImageResult {
    pub data: Vec<u8>,
    pub content_type: String,
}

impl ImageResult {
    pub fn extension(&self) -> &'static str {
        match self.content_type.as_str() {
            "image/jpeg" => ".jpg",
            "image/webp" => ".webp",
            "image/gif" => ".gif",
            _ => ".png",
        }
    }
}

impl ImageGenerator {
    pub fn new(provider: &str, api_key: String, base_url: String, model: String) -> Result<Self> {
        if model.trim().is_empty() {
            bail!("image model is not configured");
        }
        if api_key.trim().is_empty() {
            bail!("no API key for image provider {provider}");
        }
        let base_url = match (provider, base_url.trim()) {
            (_, url) if !url.is_empty() => url.trim_end_matches('/').to_string(),
            ("openrouter", _) => "https://openrouter.ai/api".to_string(),
            _ => "https://api.openai.com".to_string(),
        };
        Ok(Self {
            provider: provider.to_string(),
            api_key,
            base_url,
            model,
            client: Client::builder()
                .timeout(Duration::from_secs(300))
                .build()?,
        })
    }

    pub fn generate(
        &self,
        prompt: &str,
        size: &str,
        reference_images: &[String],
    ) -> Result<ImageResult> {
        match self.provider.as_str() {
            "openrouter" => self.generate_openrouter(prompt, reference_images),
            "openai" | "" => self.generate_openai(prompt, size),
            other => bail!("unsupported image provider {other}"),
        }
    }

    fn generate_openai(&self, prompt: &str, size: &str) -> Result<ImageResult> {
        let mut body = serde_json::json!({
            "model": self.model,
            "prompt": prompt,
            "n": 1,
        });
        if !size.trim().is_empty() {
            body["size"] = serde_json::json!(size.trim());
        }
        let resp = self
            .client
            .post(format!("{}/v1/images/generations", self.base_url))
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .context("send image request")?;
        let status = resp.status();
        let text = resp.text()?;
        if !status.is_success() {
            bail!("imagegen[openai]: HTTP {}: {}", status.as_u16(), text);
        }
        let parsed: OpenAIImageResponse = serde_json::from_str(&text)?;
        let b64 = parsed
            .data
            .first()
            .map(|d| d.b64_json.as_str())
            .filter(|s| !s.is_empty())
            .context("image response did not include b64_json")?;
        Ok(ImageResult {
            data: base64::engine::general_purpose::STANDARD.decode(b64)?,
            content_type: "image/png".to_string(),
        })
    }

    fn generate_openrouter(
        &self,
        prompt: &str,
        reference_images: &[String],
    ) -> Result<ImageResult> {
        let content = if reference_images.is_empty() {
            serde_json::json!(prompt)
        } else {
            let mut parts = Vec::new();
            for path in reference_images {
                let bytes =
                    fs::read(path).with_context(|| format!("read reference image {path}"))?;
                parts.push(serde_json::json!({
                    "type": "image_url",
                    "image_url": {
                        "url": format!("data:{};base64,{}", sniff_content_type(&bytes), base64::engine::general_purpose::STANDARD.encode(bytes))
                    }
                }));
            }
            parts.push(serde_json::json!({ "type": "text", "text": prompt }));
            serde_json::Value::Array(parts)
        };
        let body = serde_json::json!({
            "model": self.model,
            "modalities": ["image", "text"],
            "messages": [{"role": "user", "content": content}],
        });
        let resp = self
            .client
            .post(format!("{}/v1/chat/completions", self.base_url))
            .bearer_auth(&self.api_key)
            .header("content-type", "application/json")
            .header(
                "HTTP-Referer",
                "https://github.com/eight-acres-lab/openmelon",
            )
            .header("X-Title", "openmelon")
            .json(&body)
            .send()
            .context("send openrouter image request")?;
        let status = resp.status();
        let text = resp.text()?;
        if !status.is_success() {
            bail!("imagegen[openrouter]: HTTP {}: {}", status.as_u16(), text);
        }
        let parsed: OpenRouterImageResponse = serde_json::from_str(&text)?;
        let url = parsed
            .choices
            .first()
            .and_then(|c| c.message.images.first())
            .map(|img| img.image_url.url.as_str())
            .context("openrouter response did not include an image")?;
        decode_data_url(url)
    }
}

fn sniff_content_type(bytes: &[u8]) -> &'static str {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        "image/png"
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        "image/jpeg"
    } else if bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        "image/webp"
    } else {
        "image/png"
    }
}

fn decode_data_url(value: &str) -> Result<ImageResult> {
    let rest = value.strip_prefix("data:").context("not a data URL")?;
    let (header, payload) = rest.split_once(',').context("data URL missing comma")?;
    let content_type = header.split(';').next().unwrap_or("image/png").to_string();
    Ok(ImageResult {
        data: base64::engine::general_purpose::STANDARD.decode(payload)?,
        content_type,
    })
}

#[derive(Debug, Deserialize)]
struct OpenAIImageResponse {
    data: Vec<OpenAIImageData>,
}

#[derive(Debug, Deserialize)]
struct OpenAIImageData {
    b64_json: String,
}

#[derive(Debug, Deserialize)]
struct OpenRouterImageResponse {
    choices: Vec<OpenRouterChoice>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterChoice {
    message: OpenRouterMessage,
}

#[derive(Debug, Deserialize)]
struct OpenRouterMessage {
    #[serde(default)]
    images: Vec<OpenRouterImage>,
}

#[derive(Debug, Deserialize)]
struct OpenRouterImage {
    image_url: OpenRouterImageURL,
}

#[derive(Debug, Deserialize)]
struct OpenRouterImageURL {
    url: String,
}
