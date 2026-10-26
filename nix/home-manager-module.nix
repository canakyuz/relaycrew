{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.relaycrew;
  storageName = if config.services.teamclaude.enable then "teamclaude" else "relaycrew";

  inherit (lib)
    literalExpression
    mkEnableOption
    mkIf
    mkOption
    optionalString
    types
    ;

  defaultPackage = pkgs.callPackage ./package.nix { };
  configFile =
    if cfg.configFile == null then "${config.xdg.configHome}/${storageName}.json" else cfg.configFile;
  stateDirectory =
    if cfg.stateDirectory == null then "${config.xdg.stateHome}/${storageName}" else cfg.stateDirectory;

  serverArgs = [
    "server"
    "--headless"
  ]
  ++ lib.optionals (cfg.logDirectory != null) [
    "--log-to"
    cfg.logDirectory
  ]
  ++ cfg.extraArgs;

  preStart = pkgs.writeShellScript "relaycrew-user-pre-start" (
    ''
      set -eu

      config_dir="$(${pkgs.coreutils}/bin/dirname ${lib.escapeShellArg configFile})"
      ${pkgs.coreutils}/bin/install -d -m 0700 "$config_dir"
      ${pkgs.coreutils}/bin/install -d -m 0700 ${lib.escapeShellArg stateDirectory}
    ''
    + optionalString (cfg.configSource != null) ''

      if [ ! -e ${lib.escapeShellArg configFile} ]; then
        ${pkgs.coreutils}/bin/install -m 0600 \
          ${lib.escapeShellArg cfg.configSource} ${lib.escapeShellArg configFile}
      fi
    ''
    + optionalString (cfg.logDirectory != null) ''

      ${pkgs.coreutils}/bin/install -d -m 0700 ${lib.escapeShellArg cfg.logDirectory}
    ''
  );
in
{
  imports = map
    (name: lib.mkRenamedOptionModule [ "services" "teamclaude" name ] [ "services" "relaycrew" name ])
    [ "package" "installPackage" "configFile" "configSource" "stateDirectory" "host" "logDirectory" "extraArgs" "environment" "serviceConfig" ];

  options.services.teamclaude.enable = lib.mkEnableOption "the legacy RelayCrew storage layout";

  options.services.relaycrew = {
    enable = mkEnableOption "RelayCrew user proxy service";

    package = mkOption {
      type = types.package;
      default = defaultPackage;
      defaultText = literalExpression "pkgs.callPackage ./nix/package.nix { }";
      description = "RelayCrew package to run.";
    };

    installPackage = mkOption {
      type = types.bool;
      default = true;
      description = "Whether to add the RelayCrew CLI package to home.packages.";
    };

    configFile = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "~/.config/relaycrew.json";
      description = ''
        Mutable RelayCrew config path. When null, the module uses
        xdg.configHome/relaycrew.json.

        This should be writable by the user service because RelayCrew persists
        refreshed OAuth tokens, account changes, routes, quota settings, and
        runtime state next to the config.
      '';
    };

    configSource = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = literalExpression "config.sops.secrets.relaycrew-config.path";
      description = ''
        Optional seed config copied to configFile only when configFile does not
        already exist. This is intended for sops-nix Home Manager integration or
        another user-readable secret provider.
      '';
    };

    stateDirectory = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "~/.local/state/relaycrew";
      description = ''
        Working directory created for the user service. When null, the module
        uses xdg.stateHome/relaycrew.
      '';
    };

    host = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "127.0.0.1";
      description = ''
        Optional bind host override passed through RELAYCREW_HOST. Leave null
        to use RelayCrew's config/default behavior.
      '';
    };

    logDirectory = mkOption {
      type = types.nullOr types.str;
      default = null;
      example = "~/.local/state/relaycrew/logs";
      description = "Optional request/response log directory passed via --log-to.";
    };

    extraArgs = mkOption {
      type = types.listOf types.str;
      default = [ ];
      example = [ "--no-tui" ];
      description = "Extra command-line arguments appended to relaycrew server --headless.";
    };

    environment = mkOption {
      type = types.attrsOf types.str;
      default = { };
      example = {
        RELAYCREW_UPSTREAM_HEADERS_TIMEOUT_MS = "120000";
      };
      description = "Extra environment variables for the RelayCrew user service.";
    };

    serviceConfig = mkOption {
      type = types.attrsOf types.anything;
      default = { };
      example = literalExpression ''
        {
          RestartSec = "10s";
        }
      '';
      description = "Extra systemd user service settings merged into Service.";
    };
  };

  config = lib.mkMerge [
    (lib.mkIf config.services.teamclaude.enable { services.relaycrew.enable = lib.mkDefault true; })
    (mkIf cfg.enable {
    home.packages = mkIf cfg.installPackage [ cfg.package ];

    systemd.user.services.relaycrew = {
      Unit = {
        Description = "RelayCrew proxy";
      };

      Service = {
        Type = "simple";
        ExecStartPre = "${preStart}";
        ExecStart = "${lib.getExe cfg.package} ${lib.escapeShellArgs serverArgs}";
        Restart = "on-failure";
        RestartSec = "5s";
        WorkingDirectory = stateDirectory;
        Environment = [
          "RELAYCREW_CONFIG=${configFile}"
          "RELAYCREW_DISABLE_AUTOUPDATE=1"
        ]
        ++ lib.optionals (cfg.host != null) [
          "RELAYCREW_HOST=${cfg.host}"
        ]
        ++ lib.mapAttrsToList (name: value: "${name}=${value}") cfg.environment;
      }
      // cfg.serviceConfig;

      Install = {
        WantedBy = [ "default.target" ];
      };
    };
    })
  ];
}
