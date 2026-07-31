import fs from "node:fs";

const [, , capturePath, expectedText, expectedStylesJson] = process.argv;

if (!capturePath || expectedText === undefined || expectedStylesJson === undefined) {
	throw new Error("usage: assert-status-style.mjs <capture> <text> <expected-styles-json>");
}

const defaultAttributes = {
	bold: false,
	dim: false,
	italics: false,
	underscore: false,
	blink: false,
	reverse: false,
	hidden: false,
	strikethrough: false,
	overline: false,
};

const style = {
	fg: "default",
	bg: "default",
	...defaultAttributes,
};

const cells = [];

function resetStyle() {
	style.fg = "default";
	style.bg = "default";
	Object.assign(style, defaultAttributes);
}

function setExtendedColour(target, parameters, index) {
	const mode = Number(parameters[index + 1]);
	if (mode === 5 && parameters[index + 2] !== undefined) {
		style[target] = Number(parameters[index + 2]);
		return index + 2;
	}
	if (mode === 2 && parameters[index + 4] !== undefined) {
		const rgb = parameters.slice(index + 2, index + 5).map(Number);
		style[target] = `#${rgb.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
		return index + 4;
	}
	return index;
}

function applyColonParameter(parameter) {
	const values = parameter.split(":");
	const code = Number(values[0] || 0);
	if (code === 4) {
		style.underscore = true;
		return;
	}
	if ((code === 38 || code === 48) && Number(values[1]) === 5) {
		style[code === 38 ? "fg" : "bg"] = Number(values.at(-1));
		return;
	}
	if ((code === 38 || code === 48) && Number(values[1]) === 2) {
		const rgb = values.filter((value) => value !== "").slice(-3).map(Number);
		style[code === 38 ? "fg" : "bg"] = `#${rgb
			.map((value) => value.toString(16).padStart(2, "0"))
			.join("")}`;
	}
}

function applySgr(rawParameters) {
	const parameters = rawParameters === "" ? ["0"] : rawParameters.split(";");
	for (let index = 0; index < parameters.length; index += 1) {
		const parameter = parameters[index];
		if (parameter.includes(":")) {
			applyColonParameter(parameter);
			continue;
		}
		const code = Number(parameter || 0);
		switch (code) {
			case 0:
				resetStyle();
				break;
			case 1:
				style.bold = true;
				break;
			case 2:
				style.dim = true;
				break;
			case 3:
				style.italics = true;
				break;
			case 4:
			case 21:
				style.underscore = true;
				break;
			case 5:
				style.blink = true;
				break;
			case 7:
				style.reverse = true;
				break;
			case 8:
				style.hidden = true;
				break;
			case 9:
				style.strikethrough = true;
				break;
			case 22:
				style.bold = false;
				style.dim = false;
				break;
			case 23:
				style.italics = false;
				break;
			case 24:
				style.underscore = false;
				break;
			case 25:
				style.blink = false;
				break;
			case 27:
				style.reverse = false;
				break;
			case 28:
				style.hidden = false;
				break;
			case 29:
				style.strikethrough = false;
				break;
			case 38:
				index = setExtendedColour("fg", parameters, index);
				break;
			case 39:
				style.fg = "default";
				break;
			case 48:
				index = setExtendedColour("bg", parameters, index);
				break;
			case 49:
				style.bg = "default";
				break;
			case 53:
				style.overline = true;
				break;
			case 55:
				style.overline = false;
				break;
			default:
				if (code >= 30 && code <= 37) style.fg = code - 30;
				else if (code >= 40 && code <= 47) style.bg = code - 40;
				else if (code >= 90 && code <= 97) style.fg = code - 82;
				else if (code >= 100 && code <= 107) style.bg = code - 92;
		}
	}
}

const capture = fs.readFileSync(capturePath, "utf8");
for (let index = 0; index < capture.length; ) {
	if (capture[index] === "\u001b" && capture[index + 1] === "[") {
		let finalIndex = index + 2;
		while (finalIndex < capture.length && !/[@-~]/.test(capture[finalIndex])) finalIndex += 1;
		if (capture[finalIndex] === "m") applySgr(capture.slice(index + 2, finalIndex));
		index = finalIndex + 1;
		continue;
	}
	const codePoint = capture.codePointAt(index);
	const character = String.fromCodePoint(codePoint);
	cells.push({ character, style: { ...style } });
	index += character.length;
}

const plainCharacters = cells.map((cell) => cell.character);
const expectedCharacters = Array.from(expectedText);
let start = -1;
for (let candidate = 0; candidate <= plainCharacters.length - expectedCharacters.length; candidate += 1) {
	if (expectedCharacters.every((character, offset) => plainCharacters[candidate + offset] === character)) {
		start = candidate;
	}
}
if (start === -1) {
	throw new Error(
		`status text ${JSON.stringify(expectedText)} not found in ${JSON.stringify(plainCharacters.join(""))}`,
	);
}

const expectedStyles = JSON.parse(expectedStylesJson);
for (const expectation of expectedStyles) {
	const cell = cells[start + expectation.offset];
	if (!cell) throw new Error(`missing status cell at offset ${expectation.offset}`);
	if (expectedCharacters[expectation.offset] !== cell.character) {
		throw new Error(
			`status cell mismatch at offset ${expectation.offset}: expected ${JSON.stringify(expectedCharacters[expectation.offset])}, got ${JSON.stringify(cell.character)}`,
		);
	}
	for (const [property, expected] of Object.entries(expectation)) {
		if (property === "offset") continue;
		if (cell.style[property] !== expected) {
			throw new Error(
				`status style mismatch for ${JSON.stringify(cell.character)} at offset ${expectation.offset}: ${property} expected ${JSON.stringify(expected)}, got ${JSON.stringify(cell.style[property])}`,
			);
		}
	}
}
