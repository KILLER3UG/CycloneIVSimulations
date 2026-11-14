// grammars.js — custom Monaco monarch grammars for VHDL, Verilog and QSF,
// plus the light/dark Monaco themes used by the studio.

// --------------------------------------------------------------- VHDL ----
const VHDL_KEYWORDS = [
    "abs", "access", "after", "alias", "all", "and", "architecture", "array",
    "assert", "attribute", "begin", "block", "body", "buffer", "bus", "case",
    "component", "configuration", "constant", "disconnect", "downto", "else",
    "elsif", "end", "entity", "exit", "file", "for", "function", "generate",
    "generic", "group", "guarded", "if", "impure", "in", "inertial", "inout",
    "is", "label", "library", "linkage", "literal", "loop", "map", "mod",
    "nand", "new", "next", "nor", "not", "null", "of", "on", "open", "or",
    "others", "out", "package", "port", "postponed", "procedure", "process",
    "pure", "range", "record", "register", "reject", "rem", "report", "return",
    "rol", "ror", "select", "severity", "signal", "shared", "sla", "sll",
    "sra", "srl", "subtype", "then", "to", "transport", "type", "unaffected",
    "units", "until", "use", "variable", "wait", "when", "while", "with",
    "xnor", "xor",
];

const VHDL_TYPES = [
    "std_logic", "std_logic_vector", "std_ulogic", "std_ulogic_vector",
    "bit", "bit_vector", "boolean", "integer", "natural", "positive",
    "signed", "unsigned", "real", "time", "character", "string",
    "severity_level", "line", "ufixed", "sfixed", "float",
];

export const vhdlGrammar = {
    keywords: VHDL_KEYWORDS,
    types: VHDL_TYPES,
    tokenizer: {
        root: [
            [/--.*$/, "comment"],
            [/"(?:[^"\\]|\\.)*"/, "string"],
            [/'(?:[01xXzZwWhHuUlL\-]|\\.)'/, "string"],
            [/[a-zA-Z_]\w*(?=\s*\()/, { cases: { "@types": "type", "@keywords": "keyword", "@default": "identifier" } }],
            [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@types": "type", "@default": "identifier" } }],
            [/\d[\d_]*#[0-9a-fA-F_.]+#/, "number.hex"],
            [/\d[\d_]*\.\d[\d_]*(?:[eE][+-]?\d+)?/, "number.float"],
            [/\d[\d_]*/, "number"],
            [/<[=>=]|>[=>]|:=|\?\?|\?=|\/=|\*\*|<<|>>|=>|[+\-*\/&|=<>;:,.'()[\]]/, "operator"],
        ],
    },
};

// ------------------------------------------------------------- Verilog ----
const VERILOG_KEYWORDS = [
    "always", "and", "assign", "automatic", "begin", "buf", "bufif0", "bufif1",
    "case", "casex", "casez", "cell", "cmos", "config", "deassign", "default",
    "defparam", "design", "disable", "edge", "else", "end", "endcase",
    "endconfig", "endfunction", "endgenerate", "endmodule", "endprimitive",
    "endspecify", "endtable", "endtask", "event", "for", "force", "forever",
    "fork", "function", "generate", "genvar", "highz0", "highz1", "if",
    "ifnone", "incdir", "include", "initial", "inout", "input", "instance",
    "integer", "join", "large", "liblist", "library", "localparam",
    "macromodule", "medium", "module", "nand", "negedge", "nmos", "nor",
    "noshowcancelled", "not", "notif0", "notif1", "or", "output", "parameter",
    "pmos", "posedge", "primitive", "pull0", "pull1", "pulldown", "pullup",
    "pulsestyle_ondetect", "pulsestyle_onevent", "rcmos", "real", "realtime",
    "reg", "release", "repeat", "rnmos", "rpmos", "rtran", "rtranif0",
    "rtranif1", "scalared", "showcancelled", "signed", "small", "specify",
    "specparam", "strong0", "strong1", "supply0", "supply1", "table", "task",
    "time", "tran", "tranif0", "tranif1", "tri", "tri0", "tri1", "triand",
    "trior", "trireg", "unsigned", "use", "vectored", "wait", "wand", "weak0",
    "weak1", "while", "wire", "wor", "xnor", "xor",
];

export const verilogGrammar = {
    keywords: VERILOG_KEYWORDS,
    types: ["logic", "bit", "byte", "shortint", "int", "longint", "enum", "struct", "typedef", "interface", "class"],
    tokenizer: {
        root: [
            [/\/\/.*$/, "comment"],
            [/\/\*/, "comment", "@comment"],
            [/"(?:[^"\\]|\\.)*"/, "string"],
            [/'[sS]?[dDhHbBoO][0-9a-fA-F_xXzZ?]+/, "number"],
            [/\d[\d_]*\.\d[\d_]*(?:[eE][+-]?\d+)?(?:fs|ps|ns|us|ms|s)?/, "number.float"],
            [/\d[\d_]*/, "number"],
            [/[a-zA-Z_]\w*/, { cases: { "@keywords": "keyword", "@types": "type", "@default": "identifier" } }],
            [/[+\-*\/%&|^~!<>?=;:.,'()[\]#{}@]/, "operator"],
        ],
        comment: [
            [/[^\/*]+/, "comment"],
            [/\*\//, "comment", "@pop"],
            [/[/*]/, "comment"],
        ],
    },
};

// ----------------------------------------------------------------- QSF ----
// Intel Quartus Settings File: `SET_GLOBAL_ASSIGNMENT -name FAMILY "Cyclone IV E"`.
const QSF_KEYWORDS = [
    "SET_GLOBAL_ASSIGNMENT", "SET_LOCATION_ASSIGNMENT", "SET_INSTANCE_ASSIGNMENT",
    "SET_PIN_ASSIGNMENT", "SET_PARTITION", "SET_LOGICAL_ASSIGNMENT",
    "PROJECT_OUTPUT_DIRECTORY", "TOP_LEVEL_ENTITY", "FAMILY", "DEVICE",
    "POWER_PRESETS", "SUPPRESS_VHDL_RULE", "VERILOG_INPUT_VERSION",
    "VHDL_INPUT_VERSION", "VHDL_SHOW_LMF", "COMPILER_SETTINGS",
    "FITTER_SETTINGS", "EDA_INPUT_DATA_FORMAT", "EDA_OUTPUT_DATA_FORMAT",
    "ENABLE_IP_FOLDING", "OPTIMIZATION_TECHNIQUE", "CYCLONE_OPTIMIZATION_TECHNIQUE",
    "ERROR_CHECK_FREQUENCY_DIVISOR", "REMOVE_REDUNDANT_LOGIC", "AUTO_RESTART_CONFIGURATION",
    "STRATIX_OPTIMIZATION_TECHNIQUE", "USE_GENERATED_CONSTRAINTS", "GENERATE_SVF_FILE",
    "HIERARCHY_ROOT", "EDA_RUN_TOOL_ASynchronously", "INcremental_compilation",
];

export const qsfGrammar = {
    keywords: QSF_KEYWORDS,
    types: [],
    tokenizer: {
        root: [
            [/#.*$/, "comment"],
            [/"(?:[^"\\]|\\.)*"/, "string"],
            [/-[a-zA-Z_]\w*/, "type"],
            [/[A-Z_][A-Z0-9_]*/, { cases: { "@keywords": "keyword", "@default": "identifier" } }],
            [/[a-zA-Z_]\w*/, "identifier"],
            [/\d[\d_]*/, "number"],
            [/[=,()\[\]:]/, "operator"],
        ],
    },
};

// -------------------------------------------------------------- themes ----
export function defineThemes(monaco) {
    monaco.editor.defineTheme("c4-light", {
        base: "vs",
        inherit: true,
        rules: [
            { token: "comment", foreground: "8a8f98", fontStyle: "italic" },
            { token: "keyword", foreground: "0b62c4", fontStyle: "bold" },
            { token: "type", foreground: "7a3aa8" },
            { token: "string", foreground: "1a7f37" },
            { token: "number", foreground: "b25000" },
            { token: "number.hex", foreground: "b25000" },
            { token: "number.float", foreground: "b25000" },
            { token: "operator", foreground: "444c56" },
        ],
        colors: {
            "editor.background": "#fbfbfc",
            "editorLineNumber.foreground": "#9aa0aa",
            "editor.lineHighlightBackground": "#eef3fb",
            "editorGutter.background": "#f2f3f5",
        },
    });
    monaco.editor.defineTheme("c4-dark", {
        base: "vs-dark",
        inherit: true,
        rules: [
            { token: "comment", foreground: "6a7382", fontStyle: "italic" },
            { token: "keyword", foreground: "6cb6ff", fontStyle: "bold" },
            { token: "type", foreground: "c39bff" },
            { token: "string", foreground: "7ee787" },
            { token: "number", foreground: "ffa657" },
            { token: "number.hex", foreground: "ffa657" },
            { token: "number.float", foreground: "ffa657" },
            { token: "operator", foreground: "b9c2cf" },
        ],
        colors: {
            "editor.background": "#161a22",
            "editor.lineHighlightBackground": "#1e2430",
        },
    });
}

// Register the three languages. Monaco ships basic vhdl/verilog grammars, so
// unique ids ("c4-*") are used to avoid clashing with the built-in registry.
export function registerLanguages(monaco) {
    const defs = [
        { id: "c4-vhdl", grammar: vhdlGrammar },
        { id: "c4-verilog", grammar: verilogGrammar },
        { id: "c4-qsf", grammar: qsfGrammar },
    ];
    for (const { id, grammar } of defs) {
        monaco.languages.register({ id });
        monaco.languages.setMonarchTokensProvider(id, grammar);
        monaco.languages.setLanguageConfiguration(id, {
            comments: { lineComment: id === "c4-qsf" ? "#" : "--" },
            brackets: [["(", ")"]],
            autoClosingPairs: [
                { open: "(", close: ")" },
                { open: '"', close: '"' },
            ],
        });
    }
    defineThemes(monaco);
}

export function languageForFile(name) {
    const n = String(name).toLowerCase();
    if (n.endsWith(".vhd") || n.endsWith(".vhdl")) return "c4-vhdl";
    if (n.endsWith(".v") || n.endsWith(".sv")) return "c4-verilog";
    if (n.endsWith(".qsf") || n.endsWith(".qpf")) return "c4-qsf";
    return "plaintext";
}
