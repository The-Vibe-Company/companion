# Déployer Companion macOS sur TestFlight

L’application macOS native vit dans `apps/macos` et partage `CompanionKit`, l’API `/v1` et la fiche
App Store Connect `6804447784` avec l’application iOS. Le bundle Release est donc
`dev.companion.mobile` : Apple présente Companion comme une seule app multi-plateforme, tout en
traitant séparément ses builds iOS et macOS.

## Identité de distribution

- fiche App Store Connect : `6804447784`, « Companion (623507) » ;
- bundle id Release : `dev.companion.mobile` ;
- bundle id Debug : `dev.companion.mobile.dev` ;
- équipe Apple : `K28B69CWQ7` ;
- version marketing : `2.0.0` ;
- profil : `Companion macOS App Store 2026-09-01` ;
- certificat de l’app : Apple Distribution ;
- certificat du paquet d’upload : Mac Installer Distribution.

Le target Release active App Sandbox et le hardened runtime, autorise uniquement le réseau client et
les fichiers explicitement choisis en lecture seule, épingle l’API à `https://api.thecompanion.sh`,
et déclare ne pas utiliser de chiffrement non exempté. Son catalogue d’assets contient toutes les
tailles d’icône macOS dérivées de l’icône Companion canonique.

## Pipeline

`apps/macos/scripts/release.sh` crée une archive Release avec un numéro de build UTC à la seconde,
puis l’exporte avec `destination=upload`. L’upload envoie le build à App Store Connect/TestFlight ;
il ne soumet jamais une version à la revue App Store.

Le workflow `Release: macOS TestFlight` démarre uniquement après un workflow `CI` réussi sur `main`.
Il télécharge la plage `before → after` enregistrée par ce run CI, vérifie son SHA exact et ne livre
que si cette plage contient un changement sous `apps/macos/**`. Il n’expose pas de
`workflow_dispatch` sur une branche arbitraire. Une relance se fait depuis le run de livraison déjà
lié au commit approuvé.

Le job utilise l’environnement GitHub protégé `macos-testflight` et les secrets suivants :

- `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_KEY_P8` ;
- `MACOS_DISTRIBUTION_P12`, `MACOS_DISTRIBUTION_P12_PASSWORD` ;
- `MACOS_INSTALLER_P12`, `MACOS_INSTALLER_P12_PASSWORD` ;
- `MACOS_PROVISIONING_PROFILE`.

Les trois fichiers binaires sont encodés en base64 sans retour à la ligne avant leur stockage. Le
runner les installe dans un trousseau temporaire, installe le profil sous son UUID, puis supprime le
trousseau, les copies de certificats et le profil à la fin du job. La concurrence est sérialisée.

## Livraison locale autorisée

Une livraison locale utilise les certificats déjà présents dans le trousseau, le profil installé et
une clé App Store Connect conservée hors du dépôt :

```bash
ASC_KEY_ID="<key-id>" \
ASC_ISSUER_ID="<issuer-id>" \
ASC_KEY_PATH="/secure/path/AuthKey_<key-id>.p8" \
MACOS_PROVISIONING_PROFILE_SPECIFIER="Companion macOS App Store 2026-09-01" \
bash apps/macos/scripts/release.sh
```

Le numéro de build peut être fixé avec `BUILD_NUMBER`. Une archive ou un dossier d’export existant
pour ce numéro fait échouer la commande avant tout upload.

## Vérification

La vérification locale interactive passe exclusivement par XcodeBuildMCP :

```bash
xcodebuildmcp swift-package test --package-path apps/ios/CompanionKit
xcodebuildmcp macos test \
  --workspace-path apps/ios/Companion.xcworkspace \
  --scheme CompanionMac \
  --configuration Debug \
  --extra-args CODE_SIGNING_ALLOWED=NO
xcodebuildmcp macos build \
  --workspace-path apps/ios/Companion.xcworkspace \
  --scheme CompanionMac \
  --configuration Release \
  --extra-args CODE_SIGNING_ALLOWED=NO
```

Après un upload accepté, attendre le traitement Apple puis ouvrir TestFlight dans la fiche
`6804447784`. Le build doit apparaître sous macOS, séparément des builds iOS. Les groupes et
testeurs restent gérés dans App Store Connect.
