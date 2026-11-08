{
  description = "Reylo development environment";

  inputs = {
    nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";
    nub.url = "github:nubjs/nub/v0.9.6";
  };

  outputs =
    { nixpkgs, nub, ... }:
    let
      supportedSystems = [
        "aarch64-darwin"
        "aarch64-linux"
        "x86_64-linux"
      ];
      forEachSystem = nixpkgs.lib.genAttrs supportedSystems;
    in
    {
      devShells = forEachSystem (
        system:
        let
          pkgs = import nixpkgs {
            inherit system;
          };
        in
        {
          ci = pkgs.mkShell { };
          default = pkgs.mkShell {
            packages = [
              # TODO: Use Nub's official overlay when upstream provides one.
              nub.packages.${system}.default
            ];
          };
        }
      );
    };
}
