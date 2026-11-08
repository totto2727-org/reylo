{
  description = "Environment for the shared npm publishing action";

  inputs.nixpkgs.url = "https://flakehub.com/f/NixOS/nixpkgs/0.1";

  outputs =
    { nixpkgs, ... }:
    {
      # The shared publisher evaluates this shell. JavaScript tools remain managed by Vite+ and Nub.
      devShells.x86_64-linux.default = nixpkgs.legacyPackages.x86_64-linux.mkShell { };
    };
}
