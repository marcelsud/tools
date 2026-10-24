package main

import _ "embed"

// Pele 1.8.0, distributed under MIT; see assets/PELE-LICENSE.
//
//go:embed assets/pele.global.js
var peleJS []byte

//go:embed diagrams.js
var diagramsJS []byte

//go:embed editor.js
var editorJS []byte

//go:embed AGENT_INSTRUCTIONS.md
var agentInstructions string
