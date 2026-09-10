import { createMarkdownPage } from './notebook-markdown.ts';
import { createSpreadsheetPage } from './notebook-spreadsheet.ts';
import { createSlidesPage } from './notebook-slides.ts';
import { createDrawingPage } from './notebook-drawing.ts';
import type { NotebookPageType } from '../../lib/notebook-pages.ts';
import type { NotebookPageOptions, NotebookPageEngine } from './notebook-page-engine.ts';
export function createNotebookPage(type: NotebookPageType, options: NotebookPageOptions): NotebookPageEngine {
  return ({ markdown: createMarkdownPage, spreadsheet: createSpreadsheetPage, slides: createSlidesPage, drawing: createDrawingPage })[type](options);
}
