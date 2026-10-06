"""
Anti-push-to-main guardrail tests.

Verifies that _validate_branch_name and create_branch_and_commit
NEVER allow writing to main, master, or branches without the fix/ prefix.

These tests do not use the network or DynamoDB: they only test the validation
logic in crew/tools.py.
"""

from __future__ import annotations

import pytest

from crew.tools import MainBranchProtectionError, _validate_branch_name


# ─── _validate_branch_name tests ─────────────────────────────────────────────


class TestValidateBranchName:
    """Tests for the branch name validation function."""

    # Cases that MUST be blocked
    @pytest.mark.parametrize(
        "branch",
        [
            "main",
            "master",
            "MAIN",
            "MASTER",
            "Main",
            "Master",
            # Without fix/ prefix
            "feature/my-fix",
            "hotfix/something",
            "develop",
            "release/1.0",
            "",
            " main ",
            "refs/heads/main",
        ],
    )
    def test_ramas_bloqueadas(self, branch: str) -> None:
        """Protected branches or branches without fix/ prefix must raise MainBranchProtectionError."""
        with pytest.raises(MainBranchProtectionError):
            _validate_branch_name(branch)

    # Cases that MUST be allowed
    @pytest.mark.parametrize(
        "branch",
        [
            "fix/selfheal-abc12345",
            "fix/auto-repair-run-001",
            "fix/issue-42",
            "fix/my-patch",
        ],
    )
    def test_ramas_permitidas(self, branch: str) -> None:
        """Branches with fix/* prefix must pass validation without error."""
        # Must not raise an exception
        _validate_branch_name(branch)

    def test_mensaje_error_contiene_rama(self) -> None:
        """The error message must mention the problematic branch."""
        with pytest.raises(MainBranchProtectionError, match="main"):
            _validate_branch_name("main")

    def test_mensaje_error_master(self) -> None:
        """The error message must mention master."""
        with pytest.raises(MainBranchProtectionError, match="master"):
            _validate_branch_name("master")

    def test_error_es_runtime_error(self) -> None:
        """MainBranchProtectionError must be a subclass of RuntimeError."""
        assert issubclass(MainBranchProtectionError, RuntimeError)

    def test_fix_slash_no_contiene_main_como_componente(self) -> None:
        """A branch called fix/main-something contains 'main' as a component."""
        # fix/main is valid in fix/ prefix but 'main' is in the parts
        # By design: blocked if a path part == 'main'
        with pytest.raises(MainBranchProtectionError):
            _validate_branch_name("fix/main")

    def test_fix_slash_master_bloqueado(self) -> None:
        """fix/master must also be blocked."""
        with pytest.raises(MainBranchProtectionError):
            _validate_branch_name("fix/master")


# ─── parse_verdict tests ──────────────────────────────────────────────────────


class TestParseVerdict:
    """Tests for the reviewer verdict parser."""

    def test_apply_al_final(self) -> None:
        from crew.verdict import parse_verdict

        output = "Patch analysis...\n\nEverything looks good.\nVERDICT: APPLY"
        verdict, reason = parse_verdict(output)
        assert verdict == "APPLY"
        assert reason == ""

    def test_reject_con_razon(self) -> None:
        from crew.verdict import parse_verdict

        output = "The patch has issues.\nVERDICT: REJECT — malformed diff"
        verdict, reason = parse_verdict(output)
        assert verdict == "REJECT"
        assert "malformed" in reason

    def test_reject_guion_simple(self) -> None:
        from crew.verdict import parse_verdict

        output = "The patch fails.\nVERDICT: REJECT - scope too broad"
        verdict, reason = parse_verdict(output)
        assert verdict == "REJECT"
        assert "scope" in reason

    def test_sin_verdict_lanza_valueerror(self) -> None:
        from crew.verdict import parse_verdict

        with pytest.raises(ValueError, match="VERDICT"):
            parse_verdict("Analysis only without a final verdict.")

    def test_verdict_con_espacios_extra(self) -> None:
        from crew.verdict import parse_verdict

        output = "Analysis...\n  VERDICT: APPLY  "
        verdict, _ = parse_verdict(output)
        assert verdict == "APPLY"

    def test_extract_diff_bloque_valido(self) -> None:
        from crew.verdict import extract_diff

        fix_output = (
            "Patch justification.\n"
            "```diff\n"
            "--- a/src/index.ts\n"
            "+++ b/src/index.ts\n"
            "@@ -1,3 +1,3 @@\n"
            "-const x = 1;\n"
            "+const x = 2;\n"
            "```\n"
            "JUSTIFICATION: Fixes the value of x."
        )
        diff = extract_diff(fix_output)
        assert diff is not None
        assert "const x = 2" in diff

    def test_extract_diff_sin_bloque(self) -> None:
        from crew.verdict import extract_diff

        assert extract_diff("No diff here.") is None

    # ── Hardening tests (case-insensitive + markdown emphasis) ───────────────

    def test_verdict_lowercase(self) -> None:
        """parse_verdict must accept 'verdict: apply' (all lowercase)."""
        from crew.verdict import parse_verdict

        output = "Everything looks good.\nverdict: apply"
        verdict, reason = parse_verdict(output)
        assert verdict == "APPLY"
        assert reason == ""

    def test_verdict_mixed_case(self) -> None:
        """parse_verdict must accept 'Verdict: Apply' (mixed case)."""
        from crew.verdict import parse_verdict

        output = "Everything looks good.\nVerdict: Apply"
        verdict, reason = parse_verdict(output)
        assert verdict == "APPLY"
        assert reason == ""

    def test_verdict_reject_lowercase(self) -> None:
        """parse_verdict must accept 'verdict: reject — reason' (lowercase)."""
        from crew.verdict import parse_verdict

        output = "The patch has issues.\nverdict: reject — bad diff"
        verdict, reason = parse_verdict(output)
        assert verdict == "REJECT"
        assert "bad diff" in reason

    def test_verdict_markdown_bold_apply(self) -> None:
        """parse_verdict must accept '**VERDICT: APPLY**' (markdown bold emphasis)."""
        from crew.verdict import parse_verdict

        output = "Patch is correct and safe.\n**VERDICT: APPLY**"
        verdict, reason = parse_verdict(output)
        assert verdict == "APPLY"
        assert reason == ""

    def test_verdict_markdown_bold_reject(self) -> None:
        """parse_verdict must accept '**VERDICT: REJECT — reason**' (markdown bold)."""
        from crew.verdict import parse_verdict

        output = "The diff is malformed.\n**VERDICT: REJECT — reason**"
        verdict, reason = parse_verdict(output)
        assert verdict == "REJECT"
        assert "reason" in reason
