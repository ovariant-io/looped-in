-- 0003_client_profile
--
-- Two descriptive fields on clients: the company's website, and a free-text account of what it
-- actually does.
--
-- Naming: the product calls the second field "What they do", so the column, the JSON property and
-- the form label all say the same thing. `description` is the conventional name and was rejected
-- for exactly that reason — it would have drifted from the label the day someone read one without
-- the other.
--
-- Both CHECKs are length-only, like contacts.email's. Whether a website is a plausible web address
-- is judged in ClientValidation, which also NORMALIZES a scheme-less value to https:// — that is a
-- parse, not a constraint, and the detail page renders the stored value straight into an href, so
-- the scheme allow-list has to live where a 400 can be returned rather than where a violation
-- becomes a 503. The mirrored limits are MaxWebsiteLength / MaxWhatTheyDoLength.
--
-- scripts/import_clients.py names its insert columns explicitly, so every seeded row gets NULL for
-- both and the importer needs no change.
--
-- APPEND-ONLY. Once applied anywhere, this file must never be edited — see README.md.

alter table clients add column if not exists website text null
    constraint clients_website_length check (website is null or length(website) <= 500);

alter table clients add column if not exists what_they_do text null
    constraint clients_what_they_do_length check
        (what_they_do is null or length(what_they_do) <= 2000);
