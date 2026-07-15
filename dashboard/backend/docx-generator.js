import { 
  Document, 
  Packer, 
  Paragraph, 
  TextRun, 
  Table, 
  TableRow, 
  TableCell, 
  HeadingLevel, 
  BorderStyle, 
  WidthType 
} from 'docx';
import fs from 'fs/promises';

/**
 * Parses a markdown string inline text, returning an array of TextRuns with bolding applied.
 * E.g. "**John Doe**: Spoke 50 words" -> Bold TextRun for "John Doe", Regular TextRun for ": Spoke 50 words"
 */
function parseInlineFormatting(text, isH3 = false) {
  const parts = [];
  const regex = /\*\*(.*?)\*\*/g;
  let lastIndex = 0;
  let match;
  
  const fontSize = isH3 ? 22 : 20; // H3 is slightly larger

  while ((match = regex.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push(new TextRun({
        text: text.substring(lastIndex, match.index),
        font: "Segoe UI",
        size: fontSize,
        color: isH3 ? "1E293B" : "334155"
      }));
    }
    // Add bold text
    parts.push(new TextRun({
      text: match[1],
      font: "Segoe UI",
      size: fontSize,
      bold: true,
      color: "0F172A"
    }));
    lastIndex = regex.lastIndex;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    parts.push(new TextRun({
      text: text.substring(lastIndex),
      font: "Segoe UI",
      size: fontSize,
      color: isH3 ? "1E293B" : "334155"
    }));
  }
  
  return parts;
}

/**
 * Parses markdown report string and generates a beautiful docx Buffer.
 * @param {string} markdownContent 
 * @returns {Promise<Buffer>}
 */
export async function convertMarkdownToDocx(markdownContent) {
  const lines = markdownContent.split('\n');
  const children = [];
  
  let i = 0;
  while (i < lines.length) {
    let line = lines[i].trim();
    
    // Skip empty lines
    if (line === '') {
      i++;
      continue;
    }

    // Skip thematic breaks / separators
    if (line === '---' || line === '***') {
      i++;
      continue;
    }

    // Heading 1 (Title)
    if (line.startsWith('# ')) {
      const text = line.substring(2).trim();
      children.push(new Paragraph({
        children: [
          new TextRun({
            text,
            font: "Segoe UI",
            size: 32, // 16pt
            bold: true,
            color: "1E3A8A" // Dark Blue
          })
        ],
        spacing: { before: 240, after: 240 }
      }));
      i++;
      continue;
    }

    // Heading 2
    if (line.startsWith('## ')) {
      const text = line.substring(3).trim();
      children.push(new Paragraph({
        children: [
          new TextRun({
            text,
            font: "Segoe UI",
            size: 26, // 13pt
            bold: true,
            color: "2563EB" // Royal Blue
          })
        ],
        spacing: { before: 360, after: 120 }
      }));
      i++;
      continue;
    }

    // Heading 3
    if (line.startsWith('### ')) {
      const text = line.substring(4).trim();
      children.push(new Paragraph({
        children: parseInlineFormatting(text, true),
        spacing: { before: 240, after: 120 }
      }));
      i++;
      continue;
    }

    // Unordered lists
    if (line.startsWith('* ') || line.startsWith('- ')) {
      const content = line.substring(2).trim();
      children.push(new Paragraph({
        children: parseInlineFormatting(content),
        bullet: {
          level: 0
        },
        spacing: { after: 80 }
      }));
      i++;
      continue;
    }

    // Tables
    if (line.startsWith('|')) {
      const tableLines = [];
      // Consume all consecutive table lines
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        tableLines.push(lines[i].trim());
        i++;
      }

      // Convert lines to structured rows, discarding separator lines (containing '---')
      const rows = [];
      for (const tLine of tableLines) {
        if (tLine.includes('---')) continue;
        const cells = tLine
          .split('|')
          .slice(1, -1)
          .map(c => c.trim());
        rows.push(cells);
      }

      if (rows.length > 0) {
        const docxRows = rows.map((rowCells, rIndex) => {
          const isHeader = rIndex === 0;
          return new TableRow({
            children: rowCells.map(cellText => {
              return new TableCell({
                children: [
                  new Paragraph({
                    children: [
                      new TextRun({
                        text: cellText,
                        font: "Segoe UI",
                        size: 20, // 10pt
                        bold: isHeader,
                        color: isHeader ? "1E3A8A" : "334155"
                      })
                    ],
                    spacing: { before: 120, after: 120 }
                  })
                ],
                shading: isHeader ? { fill: "F1F5F9" } : undefined,
                borders: {
                  top: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
                  bottom: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
                  left: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" },
                  right: { style: BorderStyle.SINGLE, size: 4, color: "CBD5E1" }
                }
              });
            })
          });
        });

        children.push(new Table({
          rows: docxRows,
          width: {
            size: 100,
            type: WidthType.PERCENTAGE
          }
        }));
        
        // Add spacing after table
        children.push(new Paragraph({
          text: "",
          spacing: { after: 180 }
        }));
      }
      continue;
    }

    // Paragraph / regular text line
    children.push(new Paragraph({
      children: parseInlineFormatting(line),
      spacing: { after: 120 }
    }));
    i++;
  }

  // Create the Word Document sections
  const doc = new Document({
    sections: [{
      properties: {
        page: {
          margin: {
            top: 1440,    // 1 inch
            bottom: 1440,
            left: 1440,
            right: 1440
          }
        }
      },
      children
    }]
  });

  return await Packer.toBuffer(doc);
}

/**
 * Saves markdown content as a formatted Word Document to the target path.
 * @param {string} markdownContent 
 * @param {string} targetPath 
 */
export async function saveMarkdownAsDocx(markdownContent, targetPath) {
  const buffer = await convertMarkdownToDocx(markdownContent);
  await fs.writeFile(targetPath, buffer);
  console.log(`[DOCX Generator] Saved document to ${targetPath}`);
}
