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
  # Assets are built by .github/workflows/release-binaries.yml (`pnpm run sea`
  # per target) and attached to the tagged release. Homebrew's own node is
  # compiled without single-executable support and cannot build them, which is
  # why this formula ships prebuilt binaries rather than building from source.
  #
  # Every asset carries build-provenance and SBOM attestations, and releases are
  # immutable, so the sha256 below pins bytes that cannot be replaced upstream.
  # See docs/verifying-releases.md.
  #
  # Only the platforms with a published asset are listed. Adding a url/sha256
  # pair for a platform whose asset does not exist turns a clear "unsupported"
  # message into a download failure, so new platforms are added by the release
  # workflow, not by hand.
  on_macos do
    on_arm do
      url "https://github.com/artagon/acpx/releases/download/v0.12.0/acpx-0.12.0-darwin-arm64.tar.gz"
      sha256 "823fea276f249b73c9305f0b36299f0af8f8936966208e5b52ef73f6f97e2c58"
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
