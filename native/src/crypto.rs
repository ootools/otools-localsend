use base64::engine::general_purpose::STANDARD;
use base64::Engine as _;
use rcgen::{
    BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, KeyPair,
    KeyUsagePurpose, SanType,
};
use sha2::{Digest, Sha256};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::Path;
use time::{Duration, OffsetDateTime};

pub const CERT_FILE: &str = "cert.pem";
pub const KEY_FILE: &str = "key.pem";

const COMMON_NAME: &str = "LocalSend Plugin";
/// Backdate one day to tolerate clock skew between LAN peers.
const VALIDITY_BACKDATE_DAYS: i64 = 1;
const VALIDITY_DAYS: i64 = 3650;

/// TLS material served by the HTTPS endpoint (Task 7) and used to identify
/// this instance during discovery. The fingerprint is the SHA-256 hex digest
/// of the certificate DER — the LocalSend v2 fingerprint definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CertMaterial {
    pub cert_der: Vec<u8>,
    pub key_der: Vec<u8>,
    pub fingerprint: String,
}

/// Lowercase hex SHA-256 digest of `bytes`.
pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Decode the first PEM block of `pem` into its DER bytes.
pub fn pem_to_der(pem: &str) -> Result<Vec<u8>, String> {
    // PEM shape: "-----BEGIN <label>-----\n<base64>\n-----END <label>-----".
    // Splitting on the dashes yields ["", "BEGIN <label>", body, "END <label>", ...];
    // skipping the leading empty chunk leaves the label first.
    let mut sections = pem.split("-----").skip(1);
    sections
        .next()
        .ok_or_else(|| "malformed PEM: missing label".to_string())?;
    let body = sections
        .next()
        .ok_or_else(|| "malformed PEM: missing body".to_string())?;
    let base64_text: String = body.chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD
        .decode(base64_text.as_bytes())
        .map_err(|error| format!("PEM body is not valid base64: {error}"))
}

/// Ensure the data dir holds a self-signed TLS certificate.
///
/// The first call generates one with rcgen and persists `cert.pem`/`key.pem`
/// into `data_dir`; later calls load those PEM files and yield the same
/// fingerprint. SANs are fixed (localhost plus loopback IPs) on purpose:
/// LocalSend peers do not validate the certificate, so re-issuing on IP
/// changes would needlessly rotate the fingerprint.
pub fn ensure_cert(data_dir: &Path) -> Result<CertMaterial, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|error| format!("create data dir {}: {error}", data_dir.display()))?;
    if let (Ok(cert_pem), Ok(key_pem)) = (
        std::fs::read_to_string(data_dir.join(CERT_FILE)),
        std::fs::read_to_string(data_dir.join(KEY_FILE)),
    ) {
        if let Ok(material) = material_from_pem(&cert_pem, &key_pem) {
            return Ok(material);
        }
    }
    generate_and_persist(data_dir)
}

fn material_from_pem(cert_pem: &str, key_pem: &str) -> Result<CertMaterial, String> {
    let cert_der = pem_to_der(cert_pem)?;
    let key_der = pem_to_der(key_pem)?;
    Ok(CertMaterial {
        fingerprint: sha256_hex(&cert_der),
        cert_der,
        key_der,
    })
}

fn generate_and_persist(data_dir: &Path) -> Result<CertMaterial, String> {
    let (cert_pem, key_pem, material) = generate()?;
    std::fs::write(data_dir.join(CERT_FILE), cert_pem.as_bytes())
        .map_err(|error| format!("write {}: {error}", CERT_FILE))?;
    std::fs::write(data_dir.join(KEY_FILE), key_pem.as_bytes())
        .map_err(|error| format!("write {}: {error}", KEY_FILE))?;
    Ok(material)
}

fn generate() -> Result<(String, String, CertMaterial), String> {
    let key_pair = KeyPair::generate().map_err(|error| format!("generate key pair: {error}"))?;
    let mut params = CertificateParams::new(vec!["localhost".to_owned()])
        .map_err(|error| format!("certificate params: {error}"))?;
    params
        .subject_alt_names
        .push(SanType::IpAddress(IpAddr::V4(Ipv4Addr::LOCALHOST)));
    params
        .subject_alt_names
        .push(SanType::IpAddress(IpAddr::V6(Ipv6Addr::LOCALHOST)));
    params.distinguished_name.push(DnType::CommonName, COMMON_NAME);
    let now = OffsetDateTime::now_utc();
    params.not_before = now - Duration::days(VALIDITY_BACKDATE_DAYS);
    params.not_after = now + Duration::days(VALIDITY_DAYS);
    params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
    params.key_usages = vec![
        KeyUsagePurpose::DigitalSignature,
        KeyUsagePurpose::KeyCertSign,
    ];
    params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth];
    let cert = params
        .self_signed(&key_pair)
        .map_err(|error| format!("self-sign certificate: {error}"))?;
    let cert_der = cert.der().as_ref().to_vec();
    let material = CertMaterial {
        fingerprint: sha256_hex(&cert_der),
        cert_der,
        key_der: key_pair.serialize_der(),
    };
    Ok((cert.pem(), key_pair.serialize_pem(), material))
}

#[cfg(test)]
mod tests {
    use super::{ensure_cert, pem_to_der, sha256_hex, CertMaterial};

    #[test]
    fn fingerprint_known_vector() {
        // Independently precomputed:
        //   python -I -c "import hashlib;
        //   print(hashlib.sha256(b'otools-localsend-crypto-vector').hexdigest())"
        assert_eq!(
            sha256_hex(b"otools-localsend-crypto-vector"),
            "6a7ad73cccebb533ef61b33e83e1b9b25f857b59c9c7b07d0d559f15403115eb"
        );
    }

    #[test]
    fn fingerprint_matches_sha256_of_der() {
        let temp = tempfile::tempdir().expect("temp dir");
        let material: CertMaterial = ensure_cert(temp.path()).expect("ensure_cert");
        assert_eq!(material.fingerprint.len(), 64);
        assert_eq!(material.fingerprint, sha256_hex(&material.cert_der));
    }

    #[test]
    fn cert_persist_and_reload() {
        let temp = tempfile::tempdir().expect("temp dir");
        let first = ensure_cert(temp.path()).expect("first ensure_cert");
        assert!(
            temp.path().join("cert.pem").is_file(),
            "cert.pem missing in data dir"
        );
        assert!(
            temp.path().join("key.pem").is_file(),
            "key.pem missing in data dir"
        );
        let second = ensure_cert(temp.path()).expect("second ensure_cert");
        assert_eq!(first.fingerprint, second.fingerprint);
        assert_eq!(first.cert_der, second.cert_der);
        assert_eq!(first.key_der, second.key_der);
    }

    #[test]
    fn pem_rejects_garbage() {
        assert!(pem_to_der("definitely not pem").is_err());
        assert!(pem_to_der(
            "-----BEGIN CERTIFICATE-----\n!!!not base64!!!\n-----END CERTIFICATE-----\n"
        )
        .is_err());
    }
}
