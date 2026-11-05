# Format registry

Format identifiers name a **representation**, not a file extension. They are
opaque, versioned strings; compatibility is decided by exact equality and never
by sniffing content, guessing from a filename, or matching a media type.

> The identifiers below are proposed by CDEP. They are not official identifiers
> of the underlying format specifications.

## 1. Grammar

```
id      := segment ("." segment)+
segment := [a-z0-9][a-z0-9-]*
```

- Lowercase ASCII only, at most 200 characters.
- The version is part of the identifier. `…newick.v1` and `…newick.v2` are
  different formats; an implementation that reads v1 MUST NOT claim v2.
- Identifiers must not encode an extension: `.nwk`, `newick`, and `text/plain`
  are not identifiers.

Every file in a bundle declares its own format. Matching and schema checks are
per file, so a bundle may combine a Newick tree with a CSV table.

## 2. Registry v0.3

| Identifier | Label | Media types | Extensions |
| --- | --- | --- | --- |
| `org.cdep.format.newick.v1` | Newick | `text/plain` | `.nwk` `.newick` `.tree` |
| `org.cdep.format.fasta.v1` | FASTA | `text/plain`, `text/x-fasta` | `.fasta` `.fa` `.fna` `.faa` |
| `org.cdep.format.csv.v1` | CSV | `text/csv` | `.csv` |
| `org.cdep.format.nexus.v1` | Nexus | `text/plain`, `text/x-nexus` | `.nex` `.nexus` `.nxs` |
| `org.cdep.format.auspice.v2` | Auspice JSON v2 | `application/json` | `.json` |

Media types and extensions are display/discovery hints only. They never
establish compatibility.

## 3. Schemas

Some containers are not self-describing. `org.cdep.format.csv.v1` says "rows and
columns"; it says nothing about which columns. Applications that need a specific
table shape MUST also declare a schema:

```json
{
  "id": "org.cdep.format.csv.v1",
  "schema": { "id": "org.cdep.schema.tip-metadata.v1", "version": 1 }
}
```

Schema matching is as strict as format matching:

- both sides declare the same schema id **and** version → compatible;
- one side declares a schema and the other does not → **incompatible**;
- versions differ → incompatible.

The same rule applies to Auspice: the identifier must name a specific schema
version. `org.cdep.format.auspice.v2` refers only to Auspice's v2 dataset shape.

## 4. Matching rules

1. Identifiers must be byte-identical.
2. Both declared size ceilings apply; the lower one wins.
3. Schema identifiers and versions must be identical, or both absent.
4. The receiver validates the actual content after transfer.
5. Ambiguity is an error: if more than one exact match exists and the caller did
   not choose, the sender fails with `AMBIGUOUS_FORMAT` and lists candidates.

Never infer compatibility from a shared media type, extension, or structure.
Two different formats can both be `text/plain`; two CSV files can share a header
row and mean different things.

## 5. Adding formats

To propose an identifier:

1. Choose a reverse-DNS prefix you control (or an `org.cdep` identifier if the
   format belongs in the shared registry).
2. Include the representation version as the final segment.
3. State the media type and extensions as hints only.
4. Declare a schema if the representation is not self-describing.
5. Document what the receiver must validate semantically.

The `@cdep/formats` package holds the registry used by the demo apps. It is
deliberately small; unknown identifiers pass through negotiation unchanged, so
applications may use private identifiers without waiting for a registry update.

## 6. CSV caveat

Generic CSV support is **not** evidence that the receiving application
understands the dataset's columns. A tree viewer that can parse arbitrary
tabular data cannot know which column is a taxon label. In v0.3 that is
expressed by declaring generic CSV separately from schema-specific CSV imports;
the SDK will match only what the application actually implements.
