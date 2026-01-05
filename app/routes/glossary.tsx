/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, you can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * Copyright Oxide Computer Company
 */

import { useState } from 'react'
import { Link, useLoaderData, type LoaderFunctionArgs } from 'react-router'
import fs from 'fs'
import path from 'path'

import Container from '~/components/Container'
import Header from '~/components/Header'
import Icon from '~/components/Icon'
import { useRootLoaderData } from '~/root'
import { authenticate } from '~/services/auth.server'
import { fetchLocalRfd, isLocalMode } from '~/services/rfd.local.server'
import { fetchRfds, type RfdListItem } from '~/services/rfd.server'
import { fetchRemoteRfd } from '~/services/rfd.remote.server'

export type GlossaryTerm = {
  term: string
  definition: string
  mentions?: Array<{
    number: number
    text?: string
  }>
  references?: Array<{
    term: string
    anchor: string
  }>
  sources?: Array<{
    url: string
    text: string
  }>
  public?: boolean
}

export type GlossaryEntry = {
  term: string
  definition: string
  mentions: Array<{
    number: number
    formattedNumber: string
    title?: string
    exists?: boolean // Whether the RFD actually exists in the system
  }>
  references: Array<{
    term: string
    anchor: string
  }>
  sources: Array<{
    url: string
    text: string
  }>
}

function loadGlossaryTerms(): GlossaryTerm[] {
  // Get the project root directory (where glossary.d is located)
  const projectRoot = process.cwd()
  const glossaryDir = path.join(projectRoot, 'glossary.d')

  // Only include the terms that were in the original hardcoded list
  // Match case-insensitively to handle variations in capitalization
  const allowedTermsLower = new Set([
    'adoc', // Note: doesn't exist as JSON file, will be skipped
    'gimlet',
    'sidecar',
    'nexus',
    'helios',
    'crucible',
    'omicron',
    'sled',
  ])

  const terms: GlossaryTerm[] = []

  function findJsonFiles(dir: string, fileList: string[] = []): string[] {
    const files = fs.readdirSync(dir)
    for (const file of files) {
      const filePath = path.join(dir, file)
      const stat = fs.statSync(filePath)
      if (stat.isDirectory()) {
        findJsonFiles(filePath, fileList)
      } else if (file.endsWith('.json')) {
        fileList.push(filePath)
      }
    }
    return fileList
  }

  const jsonFiles = findJsonFiles(glossaryDir)

  for (const filePath of jsonFiles) {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const data = JSON.parse(content) as GlossaryTerm & {
        mentions?: Array<{ number: number; text?: string }>
        references?: Array<{ url: string; text: string }> | Record<string, never>
        relatedTerms?: Array<{ term: string; anchor: string }>
      }

      // Only include terms that are in the allowed list and marked as public (or if public field is missing, include them)
      // Match case-insensitively
      if (
        data.term &&
        data.definition &&
        allowedTermsLower.has(data.term.toLowerCase()) &&
        data.public !== false
      ) {
        // Map references to sources (references contains external URLs in JSON files)
        // Handle both array format and empty object format from JSON
        let sources: Array<{ url: string; text: string }> = []
        if (Array.isArray(data.sources)) {
          sources = data.sources
        } else if (Array.isArray(data.references)) {
          sources = data.references as Array<{ url: string; text: string }>
        }
        
        // Map relatedTerms to references (relatedTerms contains internal glossary term references in JSON files)
        const references: Array<{ term: string; anchor: string }> = Array.isArray(data.relatedTerms)
          ? (data.relatedTerms as Array<{ term: string; anchor: string }>)
          : []
        
        terms.push({
          term: data.term,
          definition: data.definition,
          mentions: Array.isArray(data.mentions) ? data.mentions : undefined,
          references,
          sources,
          public: data.public,
        })
      }
    } catch (err) {
      console.error(`Failed to load glossary term from ${filePath}:`, err)
    }
  }

  // Sort terms alphabetically by term name
  return terms.sort((a, b) => a.term.localeCompare(b.term))
}

function extractRfdReferences(definition: string): number[] {
  // Match patterns like "See RFD 46" or "See RFD 61 Control Plane Architecture and Design."
  const rfdPattern = /See\s+RFD\s+(\d+)/gi
  const rfdNumbers: number[] = []
  let match

  while ((match = rfdPattern.exec(definition)) !== null) {
    const rfdNumber = parseInt(match[1], 10)
    if (!isNaN(rfdNumber)) {
      rfdNumbers.push(rfdNumber)
    }
  }

  return rfdNumbers
}

function removeRfdReferences(definition: string): string {
  // Remove "See RFD X..." patterns, including optional title text
  // Matches: "See RFD 46 Server Sled 'Gimlet'." or "See RFD 61 Control Plane Architecture and Design."
  return definition.replace(/\.?\s*See\s+RFD\s+\d+(?:\s+[^.]*)?\.?/gi, '').trim()
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const user = await authenticate(request)
  const rfds = (await fetchRfds(user)) || []

  // Load glossary terms from JSON files
  const GLOSSARY_TERMS = loadGlossaryTerms()

  // For each glossary term, find RFDs that mention it
  const entries: GlossaryEntry[] = []

  // Create a map of RFD numbers to RFD objects for quick lookup
  const rfdMap = new Map<number, RfdListItem>()
  for (const rfd of rfds) {
    rfdMap.set(rfd.number, rfd)
  }

  for (const glossaryTerm of GLOSSARY_TERMS) {
    const mentions: Array<{ number: number; formattedNumber: string; title?: string; exists?: boolean }> = []

    // If the JSON file has mentions, use those instead of searching
    if (glossaryTerm.mentions && glossaryTerm.mentions.length > 0) {
      for (const mention of glossaryTerm.mentions) {
        const rfd = rfdMap.get(mention.number)
        if (rfd) {
          // RFD exists in the system - use the title from the RFD
          mentions.push({
            number: rfd.number,
            formattedNumber: rfd.formattedNumber,
            title: rfd.title,
            exists: true,
          })
        } else {
          // RFD doesn't exist, but we still add it as a mention with the text from JSON
          mentions.push({
            number: mention.number,
            formattedNumber: mention.number.toString().padStart(4, '0'),
            title: mention.text,
            exists: false,
          })
        }
      }
    } else {
      // Fall back to the old behavior: extract from definition and search RFD content
      // Extract RFD references from the definition (e.g., "See RFD 46...")
      const referencedRfdNumbers = extractRfdReferences(glossaryTerm.definition)
      for (const rfdNumber of referencedRfdNumbers) {
        const rfd = rfdMap.get(rfdNumber)
        if (rfd) {
          // RFD exists in the system
          mentions.push({
            number: rfd.number,
            formattedNumber: rfd.formattedNumber,
            title: rfd.title,
            exists: true,
          })
        } else {
          // RFD doesn't exist, but we still add it as a mention
          mentions.push({
            number: rfdNumber,
            formattedNumber: rfdNumber.toString().padStart(4, '0'),
            exists: false,
          })
        }
      }

      for (const rfd of rfds) {
        // Skip if already added from "See RFD..." reference
        if (referencedRfdNumbers.includes(rfd.number)) {
          continue
        }
        try {
          let content: string | undefined

          if (isLocalMode()) {
            const localRfd = fetchLocalRfd(rfd.number)
            content = localRfd.content
          } else {
            const remoteRfd = await fetchRemoteRfd(rfd.number, user)
            content = remoteRfd?.content
          }

          if (content) {
            // Case-insensitive search for the term
            // Match the term as a whole word, with plural forms, or followed by punctuation
            const escapedTerm = glossaryTerm.term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            // Match word boundary, optional plural 's', or punctuation like :: or .
            // For multi-word terms like "trust quorum", match the phrase
            const regex = new RegExp(
              `\\b${escapedTerm}(?:s|'s)?\\b|${escapedTerm}[::\\.]`,
              'i',
            )
            if (regex.test(content)) {
              mentions.push({
                number: rfd.number,
                formattedNumber: rfd.formattedNumber,
                title: rfd.title,
                exists: true,
              })
            }
          }
        } catch (err) {
          // Skip RFDs that can't be loaded
          console.error(`Failed to load RFD ${rfd.number} for glossary search:`, err)
        }
      }
    }

    // Use the definition as-is (literal value from JSON file)
    entries.push({
      term: glossaryTerm.term,
      definition: glossaryTerm.definition,
      mentions,
      references: glossaryTerm.references || [],
      sources: glossaryTerm.sources || [],
    })
  }

  return { entries }
}

function renderDefinitionWithLinks(
  definition: string,
  allTerms: string[],
  currentTerm: string,
) {
  // Create a regex pattern to match glossary term references like [[term]]
  const linkPattern = /\[\[(\w+)\]\]/g
  const parts: Array<string | JSX.Element> = []
  let lastIndex = 0
  let match

  while ((match = linkPattern.exec(definition)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      parts.push(definition.slice(lastIndex, match.index))
    }

    const linkedTermLower = match[1].toLowerCase()
    const linkedTermDisplay = match[1] // Preserve original capitalization
    // Only create a link if the term exists in the glossary and it's not the current term
    if (allTerms.includes(linkedTermLower) && linkedTermLower !== currentTerm.toLowerCase()) {
      parts.push(
        <a
          key={match.index}
          href={`#glossary-term-${linkedTermLower}`}
          className="text-accent-secondary hover:text-accent"
          onClick={(e) => {
            e.preventDefault()
            const element = document.getElementById(`glossary-term-${linkedTermLower}`)
            if (element) {
              element.scrollIntoView({ behavior: 'smooth', block: 'start' })
            }
          }}
        >
          {linkedTermDisplay}
        </a>,
      )
    } else {
      // If term doesn't exist, just show the text without brackets
      parts.push(linkedTermDisplay)
    }

    lastIndex = linkPattern.lastIndex
  }

  // Add remaining text
  if (lastIndex < definition.length) {
    parts.push(definition.slice(lastIndex))
  }

  return parts.length > 0 ? parts : definition
}

function GlossaryEntryRow({ entry, allTerms }: { entry: GlossaryEntry; allTerms: string[] }) {
  const [showSources, setShowSources] = useState(false)
  const hasSources = entry.sources.length > 0

  return (
    <Container 
      className="text-sans-md border-secondary relative rounded-lg border"
    >
      <div 
        id={`glossary-term-${entry.term.toLowerCase()}`} 
        className="flex flex-col"
      >
        <div className="800:grid 800:grid-cols-12 800:gap-6 flex flex-col gap-4 px-5 py-4">
          <div className="800:col-span-3">
            <div className="text-sans-lg 800:text-sans-md text-default">{entry.term}</div>
          </div>
          <div className="800:col-span-9">
            {entry.mentions.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {entry.mentions.map((mention, index) => (
                  <span key={mention.number}>
                    <Link
                      to={`/rfd/${mention.formattedNumber}`}
                      prefetch="intent"
                      className="text-sans-md text-accent-secondary hover:text-accent"
                    >
                      {mention.number}
                    </Link>
                    {index < entry.mentions.length - 1 && <span>,</span>}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-sans-md text-tertiary">No mentions found</span>
            )}
          </div>
        </div>
        <div className="px-5 pb-4">
          <div className="text-sans-md text-secondary">
            {renderDefinitionWithLinks(entry.definition, allTerms, entry.term)}
          </div>
          {hasSources && (
            <div className="mt-2">
              <button
                onClick={() => setShowSources(!showSources)}
                className="text-sans-sm text-tertiary hover:text-secondary flex items-center gap-1"
              >
                References
                <Icon
                  name="next-arrow"
                  size={12}
                  className={`transition-transform ${showSources ? 'rotate-90' : ''}`}
                />
              </button>
              {showSources && (
                <ol className="mt-2 text-sans-sm text-tertiary list-decimal list-inside space-y-1">
                  {entry.sources.map((source, index) => (
                    <li key={index}>
                      <a
                        href={source.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-accent-secondary hover:text-accent"
                      >
                        {source.text || source.url}
                      </a>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          )}
        </div>
      </div>
    </Container>
  )
}

export default function Glossary() {
  const { entries } = useLoaderData<typeof loader>()
  const allTerms = entries.map((e) => e.term.toLowerCase())

  return (
    <>
      <Header />
      <div className="pt-4">
        <Container>
          <h1 className="text-sans-3xl text-raise mb-8">Glossary</h1>
          <div className="space-y-3">
            <Container
              isGrid
              className="text-mono-xs text-secondary bg-raise border-secondary 800:grid hidden h-10 items-center rounded-lg border px-3"
            >
              <div className="800:col-span-3 col-span-12">Term</div>
              <div className="800:col-span-9 col-span-12">Mentions</div>
            </Container>
            {entries.map((entry) => (
              <GlossaryEntryRow key={entry.term} entry={entry} allTerms={allTerms} />
            ))}
          </div>
        </Container>
      </div>
    </>
  )
}

