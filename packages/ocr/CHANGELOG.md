# @raimonade/ocr

## 2.1.6

## 2.1.5

## 2.1.4

## 2.1.3

## 2.0.1

### Patch Changes

- 4cf21f1: Initial publish to GitHub Packages with renamed package scopes

## 1.1.0

### Minor Changes

- Add new @raimonade/ocr package for extracting structured data from invoices and receipts using AI SDK with intelligent provider fallback (Mistral → Gemini → OCR).

## 1.0.0

### Added

- Initial release
- Extract structured data from invoices and receipts using AI SDK
- Support for Mistral OCR (primary) and Gemini (fallback)
- PDF support with OCR text extraction fallback
- Quality validation with intelligent fallback
- Result merging from multiple provider attempts
- Retry logic with exponential backoff (default: 3 retries)
- Support for multiple input formats: Buffer, base64, file path, URL, File object
- Predefined schemas for invoices and receipts
- Custom schema support
