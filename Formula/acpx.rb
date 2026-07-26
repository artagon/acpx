class Acpx < Formula
  desc "Headless CLI client for the Agent Client Protocol (ACP)"
  homepage "https://github.com/artagon/acpx"
  version "0.12.0"
  license "MIT"

  # Self-contained Node single-executable application: the bundle and a V8
  # startup snapshot are injected into a Node binary, so there is no runtime
  # dependency on a system Node install and startup is ~50ms versus ~77ms for
  # the npm package.
  #
  # Release assets are produced by `pnpm run sea` on each target; see
  # docs/packaging.md. Homebrew's own node is built without single-executable
  # support and cannot produce them, which is why this formula ships a
  # prebuilt binary rather than building from source.
  on_macos do
    on_arm do
      url "https://github.com/artagon/acpx/releases/download/v0.12.0/acpx-0.12.0-darwin-arm64.tar.gz"
      sha256 "REPLACE_ON_RELEASE"
    end
    on_intel do
      url "https://github.com/artagon/acpx/releases/download/v0.12.0/acpx-0.12.0-darwin-x64.tar.gz"
      sha256 "REPLACE_ON_RELEASE"
    end
  end

  on_linux do
    on_arm do
      url "https://github.com/artagon/acpx/releases/download/v0.12.0/acpx-0.12.0-linux-arm64.tar.gz"
      sha256 "REPLACE_ON_RELEASE"
    end
    on_intel do
      url "https://github.com/artagon/acpx/releases/download/v0.12.0/acpx-0.12.0-linux-x64.tar.gz"
      sha256 "REPLACE_ON_RELEASE"
    end
  end

  def install
    bin.install "acpx"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/acpx --version")

    # The CLI must answer without a system Node on PATH — that is the whole
    # point of shipping a single executable.
    ENV.delete("NODE")
    assert_match "Usage", shell_output("#{bin}/acpx --help")
  end
end
