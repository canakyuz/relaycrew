{
  lib,
  stdenvNoCC,
  nodejs_24,
  makeWrapper,
}:

let
  packageJson = lib.importJSON ../package.json;
in
stdenvNoCC.mkDerivation {
  pname = "relaycrew";
  version = packageJson.version;

  src = lib.cleanSource ../.;

  nativeBuildInputs = [ makeWrapper ];

  dontBuild = true;

  installPhase = ''
    runHook preInstall

    mkdir -p $out/bin $out/share/relaycrew
    cp -R package.json src LICENSE README.md config.example.json $out/share/relaycrew/
    chmod +x $out/share/relaycrew/src/index.js

    makeWrapper ${lib.getExe nodejs_24} $out/bin/relaycrew \
      --add-flags "$out/share/relaycrew/src/index.js" \
      --set-default RELAYCREW_DISABLE_AUTOUPDATE 1

    ln -s $out/bin/relaycrew $out/bin/teamclaude
    ln -s $out/bin/relaycrew $out/bin/teamrouter

    runHook postInstall
  '';

  meta = {
    description = packageJson.description;
    homepage = packageJson.homepage;
    license = lib.licenses.mit;
    mainProgram = "relaycrew";
    platforms = nodejs_24.meta.platforms;
  };
}
