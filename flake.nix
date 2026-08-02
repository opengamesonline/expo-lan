{
  description = "Nix development environment for Frontend";

  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-26.05";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, utils }:
    utils.lib.eachDefaultSystem (system: 
      let
        pkgs = import nixpkgs {
          inherit system;
        };
        
      in
      {
        devShells.default = pkgs.mkShellNoCC {
          name = "Sudokuru";
          buildInputs = with pkgs; [
            git
            jq
            pre-commit
            nodejs_26
            bun
            gh
          ];

          shellHook = ''
            echo "⚡ Pinned NixOS 26.05 Development Environment Activated ⚡"
            export EXPO_LAN_ROOT=$(pwd)
            pre-commit install
            stools() {
              echo "Available tools: $(git --version), $(jq --version), node $(node --version), npm $(npm --version), $(pre-commit --version), bun $(bun --version), $(gh --version)"
            }
            stools
            export PS1="(\w) $PS1"
          '';
        };
      });
}
