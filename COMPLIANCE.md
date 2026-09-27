# Compliance status of tauri-plugin-webrtc

## Statement

**tauri-plugin-webrtc is free and open-source software stewarded by CrabNebula Ltd.** CrabNebula publishes it under MIT OR Apache-2.0 and supports its development on a sustained basis. CrabNebula does not sell it, place it on the market or make it available on the market as a product. It is not monetised in any form.

Under Regulation (EU) 2024/2847 (Cyber Resilience Act), CrabNebula therefore acts for tauri-plugin-webrtc as an **open-source software steward** (Article 3(14)), not as its manufacturer. The obligations for manufacturers do not apply to tauri-plugin-webrtc: CE marking, EU declaration of conformity, conformity assessment, Annex I essential requirements, Annex II user information and Annex VII technical documentation. The lighter steward regime of Article 24 applies instead, and is set out below.

## Basis in the Regulation

Article 2(1) applies the CRA to products with digital elements **made available on the market**. Article 3(22) defines making available on the market as supply for distribution or use on the Union market **in the course of a commercial activity, whether in return for payment or free of charge**.

The operative basis for this status is therefore not that tauri-plugin-webrtc is free of charge. Free supply in the course of a commercial activity is still making available on the market. The basis is that CrabNebula supplies tauri-plugin-webrtc **outside any commercial activity**: it is published as free and open-source software (Article 3(48)), with no price, no paid support tied to it, and no other monetisation. Recitals 18 and 19 describe this distinction.

An open-source software steward is a legal person, other than a manufacturer, that systematically provides sustained support for the development of specific free and open-source software intended for commercial activities, and ensures its viability (Article 3(14)). That describes CrabNebula's role here: tauri-plugin-webrtc is intended to be used by others, including in commercial products, and CrabNebula maintains it.

## Obligations CrabNebula accepts as steward

Article 24 sets three obligations. CrabNebula meets them as follows.

| Article | Obligation | How it is met |
|---|---|---|
| 24(1) | Put in place and document a cybersecurity policy that fosters secure development and effective vulnerability handling, including voluntary reporting of vulnerabilities | The policy in the next section |
| 24(2) | Cooperate with market surveillance authorities, on request, to mitigate risks posed by the software | CrabNebula answers such requests through the contact below and provides the documentation it holds |
| 24(3) | Article 14(1) reporting, to the extent CrabNebula is involved in development; Article 14(3) and (8), to the extent severe incidents affect systems CrabNebula provides for development | CrabNebula notifies actively exploited vulnerabilities in tauri-plugin-webrtc and qualifying incidents through the single reporting platform, within the Article 14 deadlines |

Article 64(10)(b) excludes administrative fines against open-source software stewards. That exclusion does not reduce the obligations above.

## Cybersecurity policy (Article 24(1))

**Scope.** This policy covers the tauri-plugin-webrtc source code in this repository: the Rust plugin, the JavaScript shim it injects into webviews, the Tauri permissions it defines, its test harnesses and its published releases. The WebRTC engine is qrtc, which has its own statement and policy (qrtc/COMPLIANCE.md).

**Secure development.**

- Changes are merged by the maintainer. Commits and releases are signed.
- The plugin is tested end to end in a Tauri app on WebKitGTK against headless Chromium: data channels, video and audio both ways, LiveKit rooms with and without E2EE, matrix-js-sdk 1:1 calls through Synapse, TURN over UDP, TCP and TLS through coturn, DTMF, and H.264 between two WebKit instances (`tests/`). The same harnesses drive Tchap desktop builds.
- The engine is tested in qrtc's CI on every push, with advisory checks, an SBOM drift check and interoperability tests against OpenSSL and Chromium.
- The shim installs only when the webview has no `RTCPeerConnection`. Capture and peer access need explicit Tauri permissions; the default set grants no camera, microphone or screen capture.
- The plugin uses no `unsafe` code of its own. `sbom/tauri-plugin-webrtc.cdx.json` is a CycloneDX 1.5 SBOM of the plugin with its default features.

**Vulnerability handling.**

- Report a vulnerability privately through GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"). Please do not open a public issue.
- CrabNebula acknowledges reports within 5 working days and agrees a disclosure date with the reporter. The default is 90 days after the report, or earlier once a fix is released.
- Fixes are released as a new version with a security advisory that names the affected versions. The advisory credits the reporter unless they ask otherwise.
- CrabNebula notifies actively exploited vulnerabilities under Article 14(1), as described above.

**Voluntary reporting.** CrabNebula shares vulnerability information with users and downstream maintainers through GitHub security advisories. It encourages them to report vulnerabilities they find in the plugin through the same channel. Vulnerabilities in the engine go to qrtc's repository.

## Information for integrators

A manufacturer that integrates tauri-plugin-webrtc into a product it places on the market must exercise due diligence on it as a component (Article 13(5)). That manufacturer, not CrabNebula, carries the CRA obligations for its product. Tchap desktop and other Tauri apps are such products. The following supports that due diligence.

| | |
|---|---|
| Licence | MIT OR Apache-2.0 |
| Engine | qrtc (git dependency), MIT OR Apache-2.0, stewarded by CrabNebula; see its COMPLIANCE.md |
| Protocols | ICE, STUN, TURN (UDP, TCP, TLS), DTLS 1.2 and 1.3, SRTP, SCTP data channels, RTP (Opus, VP8, H.264, RFC 4733 telephone events) |
| Cryptography | RustCrypto for DTLS, SRTP and certificates; rustls for TURN over TLS (ring or RustCrypto provider); ML-KEM from moduletto or RustCrypto ml-kem for X25519MLKEM768 |
| Validation | Not validated under FIPS 140-3 (CMVP) or any other certification scheme |
| Third-party material | Tauri 2 (runtime and plugin API); the engine's vendored crates are listed in qrtc |
| Permissions | `webrtc:default` grants peer connections and data channels only; camera, microphone and screen capture need their own permissions |
| SBOM | `sbom/tauri-plugin-webrtc.cdx.json`, CycloneDX 1.5 |
| Vulnerability reports | GitHub private vulnerability reporting on this repository |

## What would change this

This status holds only while CrabNebula supplies tauri-plugin-webrtc outside any commercial activity. Re-run the assessment before any of the following.

| Change | Effect |
|---|---|
| Charging for tauri-plugin-webrtc, or for a build, a licence exception or a distribution of it | Making available on the market. CrabNebula would become its manufacturer and the full CRA regime would apply. |
| Offering paid technical support for tauri-plugin-webrtc beyond recovering actual costs, or making it a condition of a paid service | Likely a commercial activity (Recitals 18 and 19). Assess before offering. |
| Monetising tauri-plugin-webrtc in another way, for example by processing personal data for purposes other than its security, compatibility or interoperability | Likely a commercial activity. Assess before doing so. |
| Embedding tauri-plugin-webrtc in a CrabNebula product that is placed on the market | tauri-plugin-webrtc stays stewarded open-source software. The CrabNebula product is in scope, and CrabNebula as its manufacturer must exercise Article 13(5) due diligence on tauri-plugin-webrtc as a component. |
| Transferring stewardship, or ending sustained support | Update this document. Article 24 applies to whoever acts as steward. |

Treat a change of distribution or funding model as a compliance event.

## Other instruments

This statement covers the CRA only. It is not an assessment against export control rules for cryptography, the GDPR, the NIS2 Directive or any other instrument. It says nothing about products that use tauri-plugin-webrtc.

## Record

| | |
|---|---|
| Subject | tauri-plugin-webrtc: WebRTC for Tauri webviews that lack it (WebKitGTK on Linux) |
| Status | Free and open-source software, stewarded by CrabNebula Ltd. Not placed or made available on the market as a product. Steward obligations under Article 24 apply. |
| Steward | CrabNebula Ltd, Malta (C 103590) |
| Assessed | 2026-09-27 |
| Owner | Denjell |
| Re-assess | On any change in the table above, or on a change to CRA scope guidance |
