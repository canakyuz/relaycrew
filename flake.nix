{
  description = "RelayCrew packaged as a dependency-free Node application";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAllSystems =
        f:
        builtins.listToAttrs (
          map (system: {
            name = system;
            value = f system;
          }) systems
        );
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
          relaycrew = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit relaycrew;
          teamclaude = relaycrew;
          teamrouter = relaycrew;
          default = relaycrew;
        }
      );

      checks = forAllSystems (
        system:
        let
          pkgs = nixpkgs.legacyPackages.${system};
        in
        {
          # `nix flake check` builds the package on every system.
          package = self.packages.${system}.relaycrew;
        }
        # The NixOS VM test only runs on Linux (nixosTest requires a Linux host).
        // nixpkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
          nixos-module = import ./nix/tests/module.nix { inherit pkgs self system; };
        }
      );

      apps = forAllSystems (system: {
        relaycrew = {
          type = "app";
          program = "${self.packages.${system}.relaycrew}/bin/relaycrew";
          meta = {
            inherit (self.packages.${system}.relaycrew.meta) description;
          };
        };
        teamclaude = self.apps.${system}.relaycrew;
        teamrouter = self.apps.${system}.relaycrew;
        default = self.apps.${system}.relaycrew;
      });

      nixosModules = {
        relaycrew = import ./nix/module.nix;
        teamclaude = self.nixosModules.relaycrew;
        default = self.nixosModules.relaycrew;
      };

      homeManagerModules = {
        relaycrew = import ./nix/home-manager-module.nix;
        teamclaude = self.homeManagerModules.relaycrew;
        default = self.homeManagerModules.relaycrew;
      };
    };
}
