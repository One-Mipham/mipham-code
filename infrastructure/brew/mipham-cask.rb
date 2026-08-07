# infrastructure/brew/mipham-cask.rb
#
# Homebrew Cask for Mipham Code macOS app.
#
# To install locally for testing:
#   brew install --cask ./infrastructure/brew/mipham-cask.rb
#
# To submit to homebrew-cask:
#   1. Fork https://github.com/Homebrew/homebrew-cask
#   2. Add this file to Casks/m/mipham.rb
#   3. Run: brew audit --cask --new Casks/m/mipham.rb
#   4. Submit PR

cask "mipham" do
  version "0.21.0"
  sha256 "PLACEHOLDER" # Update with: curl -sL <url> | shasum -a 256

  url "https://mipham.ai/dl/mipham-code-#{version}.dmg"
  name "Mipham Code"
  desc "Multi-model open-core intelligent coding terminal"
  homepage "https://mipham.ai/code"

  depends_on formula: "mipham"

  app "Mipham Code.app"

  zap trash: [
    "~/.mipham",
  ]

  caveats <<~EOS
    Mipham Code requires the CLI to be installed:
      brew install mipham
    Or:
      curl -fsSL https://mipham.ai/install.sh | bash
  EOS
end
