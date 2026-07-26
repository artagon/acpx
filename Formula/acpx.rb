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
  # Assets are built by .github/workflows/release.yml (`pnpm run sea` per
  # target) and attached to the tagged release. Homebrew's own node is compiled
  # without single-executable support and cannot build them, which is why this
  # formula ships prebuilt binaries rather than building from source.
  #
  # Only the platforms with a published asset are listed. Adding a url/sha256
  # pair for a platform whose asset does not exist turns a clear "unsupported"
  # message into a download failure, so new platforms are added by the release
  # workflow, not by hand.
  on_macos do
    on_arm do
      url "https://github.com/artagon/acpx/releases/download/v0.12.0/acpx-0.12.0-darwin-arm64.tar.gz"
      sha256 "a1da90a25d5e92b6d0060984eda066836556a72f573697fd5a30d86e4f2d445a"
    end
  end

  def install
    bin.install "acpx"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/acpx --version")

    # The binary must answer without a system Node on PATH — that is the
    # property that justifies shipping a ~122MB single executable.
    assert_match "Usage", shell_output("#{bin}/acpx --help")
  end
end
