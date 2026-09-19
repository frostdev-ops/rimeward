//
//  CLIPTokenizer.swift
//  CoreMLBert
//
//  Created by Matthew Waller on 1/31/23.
//  Copyright © 2023 Hugging Face. All rights reserved.
//
//  Modified by Hugues Thomas on 5/14/24.
//
//  See https://github.com/huggingface/swift-coreml-transformers/pull/30
//  Licensed under the Apache License, Version 2.0; see the NOTICE file beside this one.
//
//  Ported into BlackIce, 2026-09-18: `init(vocabURL:mergesURL:)` instead of `Bundle.main`,
//  throwing instead of `try!`, the regex compiled once, `encode_full` truncates to the
//  context length with `<|endoftext|>` last, `clean` applies the part of open_clip's ftfy
//  pass that screen text meets, and the decoder half is gone because the helper only ever
//  encodes. The upstream method names are kept so the port stays diffable against Hugging
//  Face's file.
//

import Foundation

struct BytePair: Hashable {
    let a: String
    let b: String
    init(_ a: String, _ b: String) {
        self.a = a
        self.b = b
    }
    init(tuple: [String]) {
        self.a = tuple[0]
        self.b = tuple[1]
    }
}

/// The CLIP byte-pair tokenizer the MobileCLIP text tower was trained with: lowercase,
/// split on the CLIP pattern, byte-encode, merge by rank, look the pieces up in the vocab.
final class CLIPTokenizer {
    /// What the Core ML model's `text` input expects, and what `encode_full` always returns.
    let contextLength = 77

    private let bpeRanks: [BytePair: Int]
    private let encoder: [String: Int]
    private let pattern: NSRegularExpression
    private let startOfText: Int
    private let endOfText: Int

    private static let tokenPattern =
        "<\\|startoftext\\|>|<\\|endoftext\\|>|'s|'t|'re|'ve|'m|'ll|'d|[\\p{L}]+|[\\p{N}]|[^\\s\\p{L}\\p{N}]+"

    init(vocabURL: URL, mergesURL: URL) throws {
        let vocab = try JSONDecoder().decode(
            [String: Int].self, from: try Data(contentsOf: vocabURL))
        guard let bos = vocab["<|startoftext|>"], let eos = vocab["<|endoftext|>"] else {
            throw HelperError(
                ErrorCode.unavailable, detail: "clip-vocab.json has no start/end token")
        }
        encoder = vocab
        startOfText = bos
        endOfText = eos

        // Apple ships the full 262,145-line merges table, but the vocabulary only holds
        // the merges the model was trained with: 256 byte tokens, the same 256 with
        // `</w>`, the two specials, and one entry per merge. Ranking by the whole file
        // merges past the vocabulary, the piece is not found, and `encode` silently drops
        // it: "calibration" lost two of its ids and 400 characters of "x" produced
        // nothing at all. Upstream reads every line because its own merges file is
        // already cut to size.
        let usableMerges = max(0, vocab.count - 2 * byteEncoder.count - 2)
        let merges = try String(contentsOf: mergesURL, encoding: .utf8)
        let lines = merges.split(separator: "\n")
        var ranks: [BytePair: Int] = [:]
        ranks.reserveCapacity(usableMerges)
        // Line 0 is the file's version header; rank 0 is the first real merge.
        for i in 1..<min(lines.count, usableMerges + 1) {
            let tuple = lines[i].split(separator: " ").map(String.init)
            guard tuple.count == 2 else { continue }
            ranks[BytePair(tuple: tuple)] = i - 1
        }
        bpeRanks = ranks
        pattern = try NSRegularExpression(pattern: CLIPTokenizer.tokenPattern)
    }

    func byteEncode(text: String) -> [String] {
        let matches = pattern.matches(
            in: text, options: [], range: NSRange(location: 0, length: text.utf16.count))
        let tokens = matches.compactMap { match -> String? in
            guard let range = Range(match.range, in: text) else { return nil }
            return String(text[range])
        }
        return tokens.map { token in
            Array(token.utf8).map { byteEncoder[$0]! }.joined()
        }
    }

    private func getPairs(word: [String]) -> Set<BytePair> {
        var s = Set<BytePair>()
        guard word.count > 1 else { return s }
        for i in 0..<word.count - 1 {
            s.insert(BytePair(word[i], word[i + 1]))
        }
        return s
    }

    func bpe(token: String) -> String {
        if token.count <= 1 {
            return token + "</w>"
        }

        var word = Array(token).map { String($0) }
        let last = (word.last ?? "") + "</w>"
        word.removeLast()
        word.append(last)
        var pairs = Array(getPairs(word: word))
        if pairs.isEmpty {
            return token + "</w>"
        }

        while true {
            let bigrams = pairs.filter { bpeRanks[$0] != nil }
            if bigrams.isEmpty {
                break
            }
            let bigram = bigrams.min { bpeRanks[$0]! < bpeRanks[$1]! }!
            let first = bigram.a
            let second = bigram.b
            var newWord: [String] = []
            var i = 0
            while i < word.count {
                if let j = word[i..<word.count].firstIndex(of: first) {
                    newWord.append(contentsOf: word[i..<j])
                    i = j
                } else {
                    newWord.append(contentsOf: word[i..<word.count])
                    break
                }

                if word[i] == first && i < word.count - 1 && word[i + 1] == second {
                    newWord.append(first + second)
                    i += 2
                } else {
                    newWord.append(word[i])
                    i += 1
                }
            }
            word = newWord
            if word.count == 1 {
                break
            } else {
                pairs = Array(getPairs(word: word))
            }
        }
        return word.joined(separator: " ")
    }

    /// open_clip runs `ftfy.fix_text` before it tokenizes, and the model was trained on
    /// that output. The parts of it screen text meets, in ftfy's order: curly quotes
    /// straightened, the Latin ligatures split, the U+FF01..U+FFEF width forms folded to
    /// their NFKC shapes (a fullwidth colon is a colon, halfwidth katakana is katakana),
    /// then NFC, because a macOS file name arrives decomposed. HTML entities stay as
    /// written: on a screen `&amp;` is source text. The reference ids for each case are
    /// pinned in `EmbedTests.swift`.
    static func clean(_ text: String) -> String {
        var scalars = String.UnicodeScalarView()
        for scalar in text.unicodeScalars {
            switch scalar.value {
            case 0x2BC, 0x2018...0x201B:
                scalars.append("'")
            case 0x201C...0x201F:
                scalars.append("\"")
            case 0x132, 0x133, 0xFB00...0xFB06, 0xFF01...0xFFEF:
                scalars.append(
                    contentsOf: String(scalar).precomposedStringWithCompatibilityMapping
                        .unicodeScalars)
            default:
                scalars.append(scalar)
            }
        }
        return String(scalars).precomposedStringWithCanonicalMapping
    }

    func tokenize(text: String) -> [String] {
        var tokens: [String] = []
        for token in byteEncode(text: CLIPTokenizer.clean(text).lowercased()) {
            tokens.append(contentsOf: bpe(token: token).split(separator: " ").map(String.init))
        }
        return tokens
    }

    /// Main entry point
    func encode(text: String) -> [Int] {
        tokenize(text: text).compactMap { encoder[$0] }
    }

    /// The model's input row: `<|startoftext|>`, the tokens, `<|endoftext|>`, zero padded
    /// to `contextLength`. A long text is truncated so the end token is always the last
    /// non-padding id, which is what the reference tokenizer does.
    func encode_full(text: String) -> [Int] {
        let tokens = encode(text: text).prefix(contextLength - 2)
        var fullTokens = Array(repeating: 0, count: contextLength)
        fullTokens[0] = startOfText
        for (i, token) in tokens.enumerated() {
            fullTokens[i + 1] = token
        }
        fullTokens[tokens.count + 1] = endOfText
        return fullTokens
    }
}
