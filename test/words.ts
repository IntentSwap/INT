// The words the site never uses, of private routing, of Ghost mode or of anything else. One list,
// read by every test that holds the site to it: the files a browser is sent, and the pages as they
// are drawn.
//
// Never: anonymous, untraceable, mixer, invisible, "hidden from authorities", guaranteed, and
// nothing that suggests getting round the law or sanctions. Nor anything stronger than can be
// kept: the site never says that a swap, or a visit, cannot be traced or matched.

export const NEVER = new RegExp(
  [
    // The words themselves, in any form.
    "\\b(?:anonym\\w*|pseudonym\\w*|untrac(?:e|k)ab\\w*|unlinkab\\w*|invisib\\w*|guarant\\w*|mixers?|tumbl(?:er|ers|ing))\\b",
    "hidden from (?:the )?(?:authorit|regulator|government|police|law|tax)",
    // Stronger than the provider's own word: nobody promises that a swap cannot be followed.
    "can(?:not|'t| not) be (?:traced|tracked|matched|linked|followed|identified|seen)",
    "impossible to (?:trace|track|match|link|follow|identify)",
    "(?:no one|nobody|no-one) (?:can|will) (?:see|know|trace|track|tell)",
    "(?:fully|completely|totally|truly|100%) (?:private|confidential|hidden)",
    "leaves? no trace|without (?:a )?trace",
    // Getting round the law, screening or sanctions.
    "\\b(?:evad\\w*|evasion|launder\\w*|circumvent\\w*)\\b",
    "\\bno[- ]kyc\\b|without (?:kyc|id checks?|identity checks?)|no questions asked|off the record",
    "(?:avoid|escape|beat|dodge|skip|bypass)(?:s|ing)? (?:the )?(?:sanctions|screening|regulators?|the law|taxes|tax|checks)",
  ].join("|"),
  "i",
);
