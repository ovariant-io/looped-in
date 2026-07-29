"""What a tool may hand back: contact email addresses never leave this server.

The shared client list names ~150 real people and their work email addresses —
the same personal data that keeps `/*.xlsx` and `/data/` out of git. A tool
result goes somewhere those files never do: into an LLM's context, and from
there into whatever the MCP client logs, caches, or forwards. That disclosure is
not undone by deleting a row later, so the address is dropped at the boundary
rather than trusted to every downstream client's discretion.

Nothing an agent does here needs the address. A campaign's recipient is chosen by
`contact_id`; personalization draws on names, the prose fields, and the outreach
log; and sending is a human act performed in the app, which is where the address
is actually needed. What an agent *does* need is the one bit the address carries
incidentally — whether this person is reachable at all — so `email` is replaced
by `hasEmail`, keyed in its place.

**This belongs at the tool's return, and deliberately NOT in `LoopedInApiClient`.**
The merge-style update tools re-read a row and re-send every field the caller did
not mention, because the API's PATCH is a full replacement where null clears. A
redacted read would carry `hasEmail` where the address was, and the merge would
PATCH that back into Postgres — destroying the stored address, or failing the
API's `IsPlausibleEmail` check and 400ing the edit. The internal read a merge
depends on must stay whole; only the value the tool returns is redacted. Anything
reaching for a shortcut one layer down re-opens exactly that.

Every function here is a pure transform: it copies rather than mutates (the same
payload is still backing a merge), and passes through anything that is not the
shape it expects. A tool result is not the place to raise over a payload the API
shaped differently than assumed — failing open on structure while still failing
closed on the `email` key is the safe direction, since the key is only ever
dropped, never added.
"""

from __future__ import annotations

from typing import Any, Callable

# The wire property carrying an address, and the flag that stands in for it.
# `ContactSummary.Email` and `CampaignContactOption.Email` in the API are the
# only two shapes that have it; both are handled by `redact_contact`.
_EMAIL = "email"
_FLAG = "hasEmail"


def redact_contact(contact: Any) -> Any:
    """One contact — or one campaign recipient option — without its address.

    Covers both `ContactSummary` (`get_client`, and the contact write tools'
    return) and `CampaignContactOption` (`get_campaign`'s `contactOptions`),
    which differ in their other fields but carry `email` alike.
    """
    if not isinstance(contact, dict) or _EMAIL not in contact:
        return contact
    public: dict[str, Any] = {}
    for key, value in contact.items():
        if key == _EMAIL:
            # Keyed where the address was, so the flag reads in its place rather
            # than trailing the record as an afterthought.
            public[_FLAG] = bool(value)
        else:
            public[key] = value
    return public


def redact_client(client: Any) -> Any:
    """A `ClientDetail` with every contact redacted."""
    return _map_list(client, "contacts", redact_contact)


def redact_wrapped_client(envelope: Any) -> Any:
    """Any envelope carrying a client under a `client` key.

    Two API shapes qualify: `CreateClientResponse` (`{client, warning}`) and one
    row of the bulk read (`{client, lastInteraction}`). Neither flattens the
    client, which is what lets one function serve both.
    """
    if not isinstance(envelope, dict) or "client" not in envelope:
        return envelope
    return {**envelope, "client": redact_client(envelope["client"])}


def redact_client_page(response: Any) -> Any:
    """`GET /clients/details` — a page of `{client, lastInteraction}` rows.

    The bulk read is the biggest single disclosure on the tool surface: one call
    returns up to 200 clients with every contact attached.
    """
    return _map_list(response, "clients", redact_wrapped_client)


def redact_campaign(campaign: Any) -> Any:
    """A `CampaignDetail` with its recipient options redacted.

    `messages` need no pass: a `CampaignMessage` joins the recipient's
    `contactName` for display and never their address.
    """
    return _map_list(campaign, "contactOptions", redact_contact)


def _map_list(container: Any, key: str, item: Callable[[Any], Any]) -> Any:
    """`container[key]` with each element mapped, or `container` unchanged."""
    if not isinstance(container, dict):
        return container
    values = container.get(key)
    if not isinstance(values, list):
        return container
    return {**container, key: [item(value) for value in values]}
