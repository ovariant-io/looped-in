#!/usr/bin/env python3.13
"""Turn the outreach spreadsheet into seed SQL for the `clients` / `contacts` tables.

    python3.13 scripts/import_clients.py

Writes two gitignored files:

    data/clients-import.sql          idempotent inserts, safe to run more than once
    data/clients-import-report.md    every judgment the script made, as a fix-it worklist

Design rules, in order of how often they get forgotten:

*   **Import everything, flag the bad rows, never guess.** About twenty cells are not what
    their column claims. Unparseable values are preserved verbatim in `notes` and reported;
    nothing is dropped and no typo is "corrected" by a script.

*   **Ids are deterministic UUIDv5, not UUIDv7.** The generated SQL is gitignored because it
    holds personal data, so *regenerating it is the normal path* — and regenerated UUIDv7s would
    be brand new ids, turning `on conflict (id) do nothing` into a mass-duplication bug. Every
    run of this script emits byte-identical ids, from any machine. (v7's chronological ordering
    would have been worthless here anyway: every seeded row shares one apply-time `created_at`.)

*   **Stdlib only** — `zipfile` + `xml.etree` + `uuid`. An xlsx is a zip of XML, so no dependency
    is needed in any manifest, and python3.13 is already required on the deploy host.

*   **The script asserts its own output.** If any count drifts from EXPECTED below, it writes
    nothing and exits non-zero, so a rule change cannot slip through as a "successful" run.
    Change a rule → re-derive the numbers deliberately → update EXPECTED in the same commit.
"""

from __future__ import annotations

import re
import sys
import uuid
import zipfile
import xml.etree.ElementTree as ET
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from pathlib import Path

# --------------------------------------------------------------------------------------------
# Constants that define the identity of this import. Changing any of them changes every id.
# --------------------------------------------------------------------------------------------

SOURCE_NAME = "Datbase List – 27 July 2026.xlsx"

#: Written to created_by/updated_by on every seeded row, so imported data stays distinguishable
#: from user-entered data forever — and so the whole import can be guarded by one EXISTS check.
SENTINEL = "import:datbase-list-2026-07-27"

#: A fixed namespace, so contact and client ids are a pure function of the source data.
NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "looped-in:client-import:2026-07-27")

#: Company names that must never merge, however many rows share them. Four unrelated prospects
#: are all recorded as "Unknown"; deduping by name would silently fuse them into one client.
NEVER_MERGE = {"unknown"}

#: Row 1 is a title banner and row 2 is the header (where A2 and B2 are *both* labelled "Name" —
#: A is the company, B is the person). Data starts at row 3.
FIRST_DATA_ROW = 3

COLUMNS = {"A": "Name", "B": "Name", "C": "Email", "D": "Role", "E": "Location", "F": "Industry"}

#: Counts this script must reproduce. See the module docstring: they are an assertion, not a
#: description.
#:
#: NOTE — these differ from the two hand-counted totals in PLAN-client-database.md §7, which said
#: 24 flags including 3 suspected typos. Both differences are the plan's hand-count missing
#: something real, not a rule change here:
#:   * "Managing Diretor" (row 173) is a fourth near-miss typo alongside "Goverment",
#:     "Managing Directo" and "Recriutment".
#:   * Rows 14 and 128 are one company under one name, so they merge into one client — but they
#:     disagree about Industry ("Tourism" vs "Goverment"), a case the plan's rules never spelled
#:     out. The discarded value is preserved in the client's notes and reported, not dropped.
EXPECTED = {
    "clients": 190,
    "contacts": 159,
    "contacts_with_email": 146,
    "contacts_name_only": 13,
    "clients_without_contact": 37,
    "clients_with_multiple_contacts": 6,
    "flags": 26,
}

SHEET_NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"

REPO_ROOT = Path(__file__).resolve().parent.parent
OUTPUT_DIR = REPO_ROOT / "data"


# --------------------------------------------------------------------------------------------
# Reading the spreadsheet
# --------------------------------------------------------------------------------------------


def read_rows(path: Path) -> list[tuple[int, dict[str, str]]]:
    """Read the single worksheet as (row number, {column letter: text}) pairs."""
    with zipfile.ZipFile(path) as archive:
        shared = [
            "".join(node.text or "" for node in item.iter(f"{SHEET_NS}t"))
            for item in ET.fromstring(archive.read("xl/sharedStrings.xml")).iter(f"{SHEET_NS}si")
        ]
        sheet = ET.fromstring(archive.read("xl/worksheets/sheet1.xml"))

    def text(cell: ET.Element) -> str:
        kind = cell.get("t")
        value = cell.find(f"{SHEET_NS}v")
        if kind == "s":
            return shared[int(value.text)] if value is not None and value.text else ""
        if kind == "inlineStr":
            return "".join(node.text or "" for node in cell.iter(f"{SHEET_NS}t"))
        return value.text if value is not None and value.text else ""

    rows: list[tuple[int, dict[str, str]]] = []
    for element in sheet.iter(f"{SHEET_NS}row"):
        number = int(element.get("r", "0"))
        if number < FIRST_DATA_ROW:
            continue
        cells = {}
        for cell in element.iter(f"{SHEET_NS}c"):
            reference = cell.get("r") or ""
            match = re.match(r"([A-Z]+)", reference)
            if match:
                cells[match.group(1)] = text(cell)
        rows.append((number, cells))

    rows.sort(key=lambda pair: pair[0])
    return rows


# --------------------------------------------------------------------------------------------
# Small pure helpers
# --------------------------------------------------------------------------------------------


def clean(value: str | None) -> str:
    """Trim and collapse internal whitespace runs to single spaces."""
    return re.sub(r"\s+", " ", (value or "").strip())


def normalize(value: str | None) -> str:
    """The identity form used for matching: trimmed, whitespace-collapsed, case-folded."""
    return clean(value).casefold()


EMAIL_SPLIT = re.compile(r"[,;\n\r]+")


def is_plausible_email(value: str) -> bool:
    """A deliberately conservative shape check.

    Its only job is to reject the things this column actually contained — LinkedIn URLs, a status
    note, a person's name and role, an address with a space in the domain — so they land in notes
    instead. It is not RFC 5322 and does not try to be.

    **This must stay equivalent to `ClientValidation.IsPlausibleEmail` in the API**, or a seeded
    row becomes uneditable the first time someone opens it: the importer writes straight to
    Postgres and bypasses request validation, so the API is the first code to judge these values
    and it does so only when a user tries to save. Note in particular that a trailing dot is
    tolerated on both sides — three addresses here end in a full stop, and rejecting them would
    bury three real contacts in notes.
    """
    if not value or len(value) > 320 or any(character.isspace() for character in value):
        return False
    at = value.find("@")
    if at <= 0 or at != value.rfind("@"):
        return False
    domain = value[at + 1 :]
    return len(domain) >= 3 and "." in domain and not domain.startswith(".")


def damerau_levenshtein(left: str, right: str) -> int:
    """Edit distance counting a transposition as one edit.

    Plain Levenshtein would score "Recriutment" → "Recruitment" as 2 and miss it, and swapped
    adjacent letters are the single most common typo there is.
    """
    previous: dict[int, int] = {}
    rows_: list[list[int]] = [[0] * (len(right) + 1) for _ in range(len(left) + 1)]
    for i in range(len(left) + 1):
        rows_[i][0] = i
    for j in range(len(right) + 1):
        rows_[0][j] = j

    for i in range(1, len(left) + 1):
        for j in range(1, len(right) + 1):
            cost = 0 if left[i - 1] == right[j - 1] else 1
            rows_[i][j] = min(rows_[i - 1][j] + 1, rows_[i][j - 1] + 1, rows_[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and left[i - 1] == right[j - 2] and left[i - 2] == right[j - 1]:
                rows_[i][j] = min(rows_[i][j], rows_[i - 2][j - 2] + 1)
    _ = previous
    return rows_[len(left)][len(right)]


#: Below this length a single edit is most of the string, and these columns are full of short
#: acronyms that are one edit from each other while meaning completely different things — CMO and
#: COO would both be reported as misspellings of CEO, and "SA" as one of "USA". Every real typo in
#: this sheet is a whole misspelled word, so the guard costs nothing and removes three false
#: accusations.
MIN_TYPO_LENGTH = 5


def suspected_typos(values: Counter[str]) -> list[tuple[str, str]]:
    """Values one edit away from a strictly more common value in the same column.

    Reported, never corrected (rule D4). "Strictly more common" is what keeps this from
    accusing both halves of a pair, and the plural guard stops "Co-Founder" being called a
    misspelling of "Co-Founders" — those are two real, different job titles.
    """
    found: list[tuple[str, str]] = []
    for value, count in values.items():
        if len(value) < MIN_TYPO_LENGTH:
            continue
        for other, other_count in values.items():
            if other_count <= count or len(other) < MIN_TYPO_LENGTH:
                continue
            low, other_low = value.casefold(), other.casefold()
            if low + "s" == other_low or other_low + "s" == low:
                continue
            if damerau_levenshtein(low, other_low) == 1:
                found.append((value, other))
                break
    return sorted(found)


def sql_literal(value: str | None) -> str:
    """A Postgres string literal, or NULL. Standard-conforming strings: only `'` needs doubling."""
    if value is None:
        return "null"
    return "'" + value.replace("'", "''") + "'"


# --------------------------------------------------------------------------------------------
# The model being built
# --------------------------------------------------------------------------------------------


@dataclass
class Contact:
    identity: str
    full_name: str | None
    email: str | None
    role_title: str | None
    notes: list[str] = field(default_factory=list)

    @property
    def id(self) -> uuid.UUID:
        return uuid.uuid5(NAMESPACE, f"contact:{self.identity}")


@dataclass
class Client:
    identity: str
    name: str
    industry: str | None = None
    location: str | None = None
    notes: list[str] = field(default_factory=list)
    contacts: list[Contact] = field(default_factory=list)
    rows: list[int] = field(default_factory=list)

    @property
    def id(self) -> uuid.UUID:
        return uuid.uuid5(NAMESPACE, f"client:{self.identity}")


@dataclass
class Flag:
    kind: str
    row: int | None
    message: str


class Importer:
    def __init__(self) -> None:
        self.clients: dict[str, Client] = {}
        self.flags: list[Flag] = []
        self.skipped: list[int] = []

    # -- rule 1 & 2 ---------------------------------------------------------------------------

    def client_for(self, row_number: int, company: str) -> Client:
        """Find or create the client for this row's company name.

        Deduped on the normalized name, except for the never-merge list, where the row number is
        folded into the identity so each row stands alone — and, because the identity feeds the
        UUIDv5, so does each row's id.
        """
        key = normalize(company)
        identity = f"{key}#row{row_number}" if key in NEVER_MERGE else key

        client = self.clients.get(identity)
        if client is None:
            client = Client(identity=identity, name=clean(company))
            self.clients[identity] = client
        client.rows.append(row_number)
        return client

    def merge_field(self, client: Client, attribute: str, row_number: int, value: str) -> None:
        """First non-empty value wins; a conflicting one is preserved in notes and flagged.

        Six companies appear on two rows. Where those rows disagree, keeping the first silently
        would drop real information — and in this sheet the discarded value is itself a typo
        worth seeing ("Goverment"), so losing it would also hide a cleanup item.
        """
        current = getattr(client, attribute)
        if not value or normalize(current) == normalize(value):
            return
        if current is None:
            setattr(client, attribute, value)
            return

        label = attribute.capitalize()
        client.notes.append(
            f'Row {row_number} recorded "{label}" as "{value}"; kept "{current}" from '
            f"row {client.rows[0]}."
        )
        self.flags.append(
            Flag(
                "merged-row-conflict",
                row_number,
                f'"{client.name}" appears on rows {", ".join(str(r) for r in client.rows)} with '
                f'different {label} values ("{current}" vs "{value}"). Kept "{current}"; the other '
                f"is in the client's notes.",
            )
        )

    # -- rules 3, 3a, 4, 5 --------------------------------------------------------------------

    def add_row(self, row_number: int, cells: dict[str, str]) -> None:
        company = clean(cells.get("A"))
        if not company:
            self.skipped.append(row_number)
            self.flags.append(
                Flag("empty-company", row_number, "Row has no company name and was skipped.")
            )
            return

        client = self.client_for(row_number, company)
        self.merge_field(client, "industry", row_number, clean(cells.get("F")))
        self.merge_field(client, "location", row_number, clean(cells.get("E")))

        person = clean(cells.get("B"))
        role = clean(cells.get("D"))
        raw_email = (cells.get("C") or "").strip()

        # Rule 7: a person cell holding a role too, or two people, is kept verbatim and flagged
        # with a suggested split. Splitting it here would be a guess about which half is which.
        if person and ("," in person or re.search(r"\band\b|&|\+", person, re.IGNORECASE)):
            self.flags.append(
                Flag(
                    "person-cell-needs-split",
                    row_number,
                    f'"{client.name}" — the Name cell reads "{person}". Split it into a name and '
                    "a role, or into two contacts.",
                )
            )

        parts = [part.strip() for part in EMAIL_SPLIT.split(raw_email) if part.strip()]
        usable = bool(parts) and all(is_plausible_email(part) for part in parts)

        if not raw_email:
            self.add_contact(client, row_number, person or None, None, role or None, [])
            return

        if not usable:
            # Rule 3: one rule for every kind of junk in this column. The cell is preserved
            # verbatim so a human can read it and decide.
            note = f'Original "Email" cell: {raw_email}'
            self.flags.append(
                Flag(
                    "unusable-email",
                    row_number,
                    f'"{client.name}" — the Email cell reads "{raw_email}", which is not an '
                    "address. It is preserved in notes.",
                )
            )
            if person:
                self.add_contact(client, row_number, person, None, role or None, [note])
            else:
                # Rule 5: no name and no address means no contact to hang this on — so it goes
                # to the client, because "nothing is dropped" outranks tidiness.
                client.notes.append(f"Row {row_number}: {note}")
            return

        if len(parts) == 1:
            self.add_contact(client, row_number, person or None, parts[0], role or None, [])
            return

        # Rule 3a: several addresses, one Name cell. Attaching the name to either address would
        # be a guess, so it attaches to neither and is carried in both contacts' notes.
        carried = [f'Original "{COLUMNS[column]}" cell: {text}'
                   for column, text in (("B", person), ("D", role)) if text]
        self.flags.append(
            Flag(
                "name-not-attached",
                row_number,
                f'"{client.name}" — the Email cell held {len(parts)} addresses '
                f'({", ".join(parts)}), so "{person or role}" was not attached to either. '
                "Assign it to the right person.",
            )
        )
        for part in parts:
            self.add_contact(client, row_number, None, part, None, list(carried))

    def add_contact(
        self,
        client: Client,
        row_number: int,
        full_name: str | None,
        email: str | None,
        role_title: str | None,
        notes: list[str],
    ) -> None:
        """Rules 4 and 5: dedupe within the client, and create nothing that names nobody."""
        if not full_name and not email:
            return

        if email is not None:
            existing = next(
                (c for c in client.contacts if c.email and c.email.casefold() == email.casefold()),
                None,
            )
            if existing is not None:
                self.flags.append(
                    Flag(
                        "duplicate-contact-collapsed",
                        row_number,
                        f'"{client.name}" — {email} was already recorded for this client, so '
                        f"row {row_number} did not create a second contact. Anything unique about "
                        "that row (a different name or role) is in the contact's notes.",
                    )
                )
                for extra in (full_name, role_title):
                    if extra:
                        existing.notes.append(f"Also recorded on row {row_number}: {extra}")
                return
            identity = f"{client.identity}|{email.casefold()}"
        else:
            # A name-only candidate loses to ANY existing contact of this client with the same
            # name, address-bearing or not — otherwise the same person appears twice, once with
            # an address and once without.
            existing = next(
                (c for c in client.contacts if c.full_name and normalize(c.full_name) == normalize(full_name)),
                None,
            )
            if existing is not None:
                self.flags.append(
                    Flag(
                        "duplicate-contact-collapsed",
                        row_number,
                        f'"{client.name}" — "{full_name}" was already recorded for this client, '
                        f"so row {row_number} did not create a second contact.",
                    )
                )
                return
            identity = f"{client.identity}|name:{normalize(full_name)}"

        client.contacts.append(
            Contact(
                identity=identity,
                full_name=full_name,
                email=email,
                role_title=role_title,
                notes=list(notes),
            )
        )


# --------------------------------------------------------------------------------------------
# Cross-row observations (rules 6 and 8)
# --------------------------------------------------------------------------------------------


def near_duplicate_clients(clients: list[Client]) -> list[tuple[Client, Client]]:
    """Client names that are equal once a leading "the" is stripped.

    One firm is recorded both with and without it, sharing a single address. Clearly the same
    organisation — but no safe rule merges them (plenty of real companies differ by more than an
    article), so they are imported as two and reported for a human to merge.
    """
    groups: dict[str, list[Client]] = defaultdict(list)
    for client in clients:
        groups[re.sub(r"^the\s+", "", client.identity)].append(client)

    pairs = []
    for members in groups.values():
        if len(members) > 1 and len({m.identity for m in members}) > 1:
            ordered = sorted(members, key=lambda c: c.name)
            pairs.append((ordered[0], ordered[1]))
    return pairs


def collect_typos(rows: list[tuple[int, dict[str, str]]]) -> list[tuple[str, str, str]]:
    """(column label, value, likely intended value) for every near-miss in a free-text column."""
    found = []
    for column in ("D", "E", "F"):
        values = Counter(clean(cells.get(column)) for _, cells in rows if clean(cells.get(column)))
        for value, likely in suspected_typos(values):
            found.append((COLUMNS[column], value, likely))
    return found


# --------------------------------------------------------------------------------------------
# Output
# --------------------------------------------------------------------------------------------


def render_sql(clients: list[Client]) -> str:
    """Idempotent seed SQL.

    Three independent guards, because re-running this is the normal path:
      1. the whole thing is one transaction (a DO block), so it is all-or-nothing;
      2. it returns early if any row already carries the sentinel — so even a rule change that
         alters every id cannot double-import;
      3. `on conflict (id) do nothing`, which the deterministic UUIDv5 ids make meaningful.
    """
    lines = [
        f"-- Seed data generated from {SOURCE_NAME} by scripts/import_clients.py.",
        "-- DO NOT COMMIT: this file contains personal data (it is gitignored via /data/).",
        "-- Regenerate with: python3.13 scripts/import_clients.py",
        "--",
        f"-- {len(clients)} clients, {sum(len(c.contacts) for c in clients)} contacts.",
        "-- Ids are deterministic (UUIDv5), so every regeneration produces this same file and",
        "-- re-applying it changes nothing.",
        "",
        "do $import$",
        "begin",
        "    if exists (select 1 from clients where created_by = "
        f"{sql_literal(SENTINEL)}) then",
        "        raise notice 'Seed data is already present; nothing to do.';",
        "        return;",
        "    end if;",
        "",
        "    insert into clients (id, name, industry, location, notes, created_by, updated_by)",
        "    values",
    ]

    client_values = []
    for client in clients:
        notes = "\n".join(client.notes) if client.notes else None
        client_values.append(
            f"        ('{client.id}', {sql_literal(client.name)}, "
            f"{sql_literal(client.industry)}, {sql_literal(client.location)}, "
            f"{sql_literal(notes)}, {sql_literal(SENTINEL)}, {sql_literal(SENTINEL)})"
        )
    lines.append(",\n".join(client_values))
    lines.append("    on conflict (id) do nothing;")
    lines.append("")

    contact_values = []
    for client in clients:
        for contact in client.contacts:
            notes = "\n".join(contact.notes) if contact.notes else None
            contact_values.append(
                f"        ('{contact.id}', '{client.id}', {sql_literal(contact.full_name)}, "
                f"{sql_literal(contact.email)}, {sql_literal(contact.role_title)}, "
                f"{sql_literal(notes)}, {sql_literal(SENTINEL)}, {sql_literal(SENTINEL)})"
            )

    if contact_values:
        lines.append(
            "    insert into contacts (id, client_id, full_name, email, role_title, notes, "
            "created_by, updated_by)"
        )
        lines.append("    values")
        lines.append(",\n".join(contact_values))
        lines.append("    on conflict (id) do nothing;")
        lines.append("")

    lines.append("end")
    lines.append("$import$;")
    return "\n".join(lines) + "\n"


def render_report(
    clients: list[Client],
    flags: list[Flag],
    typos: list[tuple[str, str, str]],
    near_duplicates: list[tuple[Client, Client]],
    counts: dict[str, int],
) -> str:
    by_kind: dict[str, list[Flag]] = defaultdict(list)
    for flag in flags:
        by_kind[flag.kind].append(flag)

    out = [
        "# Client import report",
        "",
        f"Generated from `{SOURCE_NAME}` by `scripts/import_clients.py`.",
        "",
        "**Not committed** — this file names real people and addresses (gitignored via `/data/`).",
        "",
        "Everything below was imported. Nothing was dropped and nothing was silently corrected;",
        "these are the judgment calls, listed so they can be resolved in the UI (plan step 12).",
        "",
        "## Counts",
        "",
        "| Metric | Value |",
        "| --- | --- |",
    ]
    for key, value in counts.items():
        out.append(f"| {key.replace('_', ' ')} | {value} |")

    out += ["", f"**{len(flags)} flagged items**, one per judgment (a row can carry several).", ""]

    titles = {
        "unusable-email": "Email cells that are not addresses",
        "person-cell-needs-split": "Name cells holding a role, or two people",
        "name-not-attached": "Multi-address cells where the name could not be attached",
        "duplicate-contact-collapsed": "Contacts recorded twice under one client",
        "merged-row-conflict": "Rows that merged into one client but disagreed",
        "empty-company": "Rows skipped for having no company name",
    }
    for kind, title in titles.items():
        entries = by_kind.get(kind, [])
        if not entries:
            continue
        out += [f"## {title} ({len(entries)})", ""]
        for flag in sorted(entries, key=lambda f: f.row or 0):
            out.append(f"- **Row {flag.row}** — {flag.message}")
        out.append("")

    if near_duplicates:
        out += [f"## Clients that may be the same organisation ({len(near_duplicates)})", ""]
        for left, right in near_duplicates:
            out.append(
                f'- **"{left.name}"** (rows {", ".join(str(r) for r in left.rows)}) and '
                f'**"{right.name}"** (rows {", ".join(str(r) for r in right.rows)}) differ only by '
                "a leading article. Imported separately — merge them by hand if they are one firm."
            )
        out.append("")

    if typos:
        out += [f"## Suspected typos ({len(typos)})", "",
                "Copied verbatim into the database. Fixing them is a two-minute job in the UI; a",
                "script that guesses is a script you have to audit.", "",
                "| Column | Recorded | Probably meant |", "| --- | --- | --- |"]
        for column, value, likely in typos:
            out.append(f"| {column} | `{value}` | `{likely}` |")
        out.append("")

    out += [
        "## Applying",
        "",
        "```sh",
        'psql "$DATABASE_URL" -f data/clients-import.sql',
        "```",
        "",
        f"Guarded by the `{SENTINEL}` sentinel and by deterministic ids, so running it twice is a",
        "no-op. Everything it inserts carries that sentinel in `created_by`, which is how seeded",
        "rows stay distinguishable from user-entered ones — including after they are edited.",
        "",
    ]
    return "\n".join(out)


# --------------------------------------------------------------------------------------------


def main(argv: list[str]) -> int:
    source = Path(argv[1]) if len(argv) > 1 else REPO_ROOT / SOURCE_NAME
    if not source.exists():
        print(f"error: {source} not found.", file=sys.stderr)
        print("The spreadsheet is deliberately untracked; put it at the repo root.", file=sys.stderr)
        return 2

    rows = read_rows(source)
    importer = Importer()
    for row_number, cells in rows:
        importer.add_row(row_number, cells)

    clients = list(importer.clients.values())
    near_duplicates = near_duplicate_clients(clients)
    for left, right in near_duplicates:
        importer.flags.append(
            Flag("near-duplicate-clients", left.rows[0],
                 f'"{left.name}" and "{right.name}" may be the same organisation.'))

    typos = collect_typos(rows)
    for column, value, likely in typos:
        importer.flags.append(
            Flag("suspected-typo", None, f'{column} "{value}" is probably "{likely}".'))

    contacts = [contact for client in clients for contact in client.contacts]
    counts = {
        "source rows": len(rows),
        "clients": len(clients),
        "contacts": len(contacts),
        "contacts_with_email": sum(1 for c in contacts if c.email),
        "contacts_name_only": sum(1 for c in contacts if not c.email),
        "clients_without_contact": sum(1 for c in clients if not c.contacts),
        "clients_with_multiple_contacts": sum(1 for c in clients if len(c.contacts) > 1),
        "flags": len(importer.flags),
    }

    drift = {key: (counts[key], expected)
             for key, expected in EXPECTED.items() if counts.get(key) != expected}
    if drift:
        print("error: the import no longer produces the expected counts.", file=sys.stderr)
        for key, (actual, expected) in drift.items():
            print(f"  {key}: got {actual}, expected {expected}", file=sys.stderr)
        print(
            "\nNothing was written. Either a rule changed or the spreadsheet did — work out\n"
            "which, then update EXPECTED in this script in the same commit.",
            file=sys.stderr,
        )
        return 1

    sql = render_sql(clients)
    if "$import$" in sql.replace("do $import$", "").replace("$import$;", ""):
        print("error: source data contains the dollar-quote tag; change it.", file=sys.stderr)
        return 1

    OUTPUT_DIR.mkdir(exist_ok=True)
    (OUTPUT_DIR / "clients-import.sql").write_text(sql, encoding="utf-8")
    (OUTPUT_DIR / "clients-import-report.md").write_text(
        render_report(clients, importer.flags, typos, near_duplicates, counts), encoding="utf-8")

    for key, value in counts.items():
        print(f"{key:34} {value}")
    print(f"\nwrote {OUTPUT_DIR / 'clients-import.sql'}")
    print(f"wrote {OUTPUT_DIR / 'clients-import-report.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
