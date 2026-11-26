use super::document_snapshot::validate_json_keys;
use crate::Result;
use bson::{Bson, DateTime, Decimal128, Document};
use serde::Deserialize;
use std::{borrow::Cow, collections::HashSet};

const MAX_COLUMNS: usize = 64;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CsvField {
    name: String,
    kind: CsvKind,
}

#[derive(Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "snake_case")]
enum CsvKind {
    Text,
    Int32,
    Int64,
    Double,
    Decimal128,
    Boolean,
    DateTime,
    ExtendedJson,
    Skip,
}

impl CsvKind {
    fn convert(self, cell: Cell<'_>) -> Result<Bson> {
        let text = cell.text.as_ref();
        if !cell.quoted && text == "\\N" {
            return Ok(Bson::Null);
        }
        let invalid = "선택한 BSON 타입으로 변환할 수 없습니다.";
        let value = match self {
            Self::Text => Bson::String(cell.text.into_owned()),
            Self::Int32 => Bson::Int32(text.parse().map_err(|_| invalid)?),
            Self::Int64 => Bson::Int64(text.parse().map_err(|_| invalid)?),
            Self::Double => {
                let value: f64 = text.parse().map_err(|_| invalid)?;
                if !value.is_finite() {
                    return Err(
                        "유한한 실수나 Extended JSON으로 표시한 BSON 값을 사용하세요.".into(),
                    );
                }
                Bson::Double(value)
            }
            Self::Decimal128 => Bson::Decimal128(text.parse::<Decimal128>().map_err(|_| invalid)?),
            Self::Boolean => Bson::Boolean(text.parse().map_err(|_| invalid)?),
            Self::DateTime => {
                Bson::DateTime(DateTime::parse_rfc3339_str(text).map_err(|_| invalid)?)
            }
            Self::ExtendedJson => {
                validate_json_keys::<{ usize::MAX }>(text, 0, 104)?;
                serde_json::from_str::<Bson>(text).map_err(|_| invalid)?
            }
            Self::Skip => unreachable!("skipped fields are not converted"),
        };
        Ok(value)
    }
}

pub(super) fn column_labels(contents: &str, header: bool) -> Result<Vec<String>> {
    let row = CsvRecords::new(contents)
        .next()
        .ok_or("CSV 파일에 열이 없습니다.")??;
    if header {
        Ok(row
            .into_iter()
            .map(|cell| {
                let label = cell.text.as_ref();
                if label.len() > 256 {
                    format!("{}…", &label[..label.floor_char_boundary(256)])
                } else {
                    cell.text.into_owned()
                }
            })
            .collect())
    } else {
        Ok((1..=row.len())
            .map(|index| format!("column_{index}"))
            .collect())
    }
}

pub(super) fn documents<'a>(
    contents: &'a str,
    header: bool,
    fields: &'a [CsvField],
) -> Result<impl Iterator<Item = Result<Document>> + 'a> {
    let mut names = HashSet::new();
    if !(1..=MAX_COLUMNS).contains(&fields.len())
        || fields
            .iter()
            .filter(|field| field.kind != CsvKind::Skip)
            .any(|field| {
                field.name.trim().is_empty()
                    || field.name.len() > 256
                    || field.name.contains('\0')
                    || field.name.starts_with('$')
                    || !names.insert(field.name.as_str())
            })
        || names.is_empty()
    {
        return Err("가져올 CSV 열에 비어 있지 않은 고유 필드 이름을 지정하세요. 필드 이름은 $로 시작할 수 없습니다.".into());
    }
    let mut rows = CsvRecords::new(contents);
    if header
        && rows
            .next()
            .transpose()?
            .is_some_and(|row| row.len() != fields.len())
    {
        return Err("CSV 머리글과 열 매핑의 열 수가 다릅니다. 파일을 다시 읽으세요.".into());
    }
    Ok(rows.map(move |row| {
        let row = row?;
        if row.len() != fields.len() {
            return Err("CSV 레코드의 열 수가 확인한 열 수와 다릅니다.".into());
        }
        let mut document = Document::new();
        for (index, (cell, field)) in row.into_iter().zip(fields).enumerate() {
            if field.kind != CsvKind::Skip {
                let value = field
                    .kind
                    .convert(cell)
                    .map_err(|error| format!("{}열: {error}", index + 1))?;
                document.insert(field.name.as_str(), value);
            }
        }
        Ok(document)
    }))
}

struct Cell<'a> {
    text: Cow<'a, str>,
    quoted: bool,
}

struct CsvRecords<'a> {
    unread: &'a str,
}

impl<'a> CsvRecords<'a> {
    fn new(contents: &'a str) -> Self {
        Self { unread: contents }
    }

    fn read_cell(&mut self) -> Result<Cell<'a>> {
        let start = self.unread;
        let Some(mut remaining) = start.strip_prefix('"') else {
            let end = start.find([',', '\r', '\n', '"']).unwrap_or(start.len());
            self.unread = &start[end..];
            return Ok(Cell {
                text: Cow::Borrowed(&start[..end]),
                quoted: false,
            });
        };
        let mut escaped = None::<String>;
        loop {
            let end = remaining
                .find('"')
                .ok_or("CSV 열의 닫는 따옴표가 없습니다.")?;
            let segment = &remaining[..end];
            remaining = &remaining[end + 1..];
            if let Some(tail) = remaining.strip_prefix('"') {
                let value = escaped.get_or_insert_with(String::new);
                value.push_str(segment);
                value.push('"');
                remaining = tail;
            } else {
                self.unread = remaining;
                let text = match escaped {
                    Some(mut value) => {
                        value.push_str(segment);
                        Cow::Owned(value)
                    }
                    None => Cow::Borrowed(segment),
                };
                return Ok(Cell { text, quoted: true });
            }
        }
    }

    fn read_row(&mut self) -> Result<Vec<Cell<'a>>> {
        let mut row = Vec::new();
        loop {
            if row.len() == MAX_COLUMNS {
                return Err("CSV 파일에 최대 64개 열을 사용할 수 있습니다.".into());
            }
            row.push(self.read_cell()?);
            match self.unread.as_bytes().first() {
                Some(b',') => self.unread = &self.unread[1..],
                Some(b'\r' | b'\n') => {
                    self.unread = self
                        .unread
                        .strip_prefix("\r\n")
                        .unwrap_or(&self.unread[1..]);
                    return Ok(row);
                }
                None => return Ok(row),
                _ => return Err("CSV 따옴표와 구분자를 확인하세요.".into()),
            }
        }
    }
}

impl<'a> Iterator for CsvRecords<'a> {
    type Item = Result<Vec<Cell<'a>>>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.unread.is_empty() {
            return None;
        }
        let result = self.read_row();
        if result.is_err() {
            self.unread = "";
        }
        Some(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_csv_quoting_and_distinguishes_null_from_literal_text() {
        let first = CsvField {
            name: "first".into(),
            kind: CsvKind::Text,
        };
        let second = CsvField {
            name: "second".into(),
            kind: CsvKind::Text,
        };
        let third = CsvField {
            name: "third".into(),
            kind: CsvKind::Text,
        };
        let fields = [first, second, third];
        let source = "one,two,three\r\n\"한글, \"\"인용\"\"\r\n둘째 줄\",\\N,\"\\N\"\r\n,,";
        let docs = documents(source, true, &fields)
            .unwrap()
            .collect::<Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            docs[0].get_str("first").unwrap(),
            "한글, \"인용\"\r\n둘째 줄"
        );
        assert_eq!(docs[0].get("second"), Some(&Bson::Null));
        assert_eq!(docs[0].get_str("third").unwrap(), "\\N");
        assert_eq!(docs[1].get_str("third").unwrap(), "");
    }

    #[test]
    fn validates_csv_shape_and_field_types() {
        let fields = [CsvField {
            name: "long".into(),
            kind: CsvKind::Int64,
        }];
        assert!(column_labels("\"bad\"tail\n", true).is_err());
        assert!(column_labels("a\"bad\n", true).is_err());
        assert!(column_labels("\"unterminated", true).is_err());
        assert!(documents("one,two\n1,2", true, &fields).is_err());
        assert!(documents("9223372036854775808", false, &fields)
            .unwrap()
            .next()
            .unwrap()
            .is_err());
        let valid = documents("9223372036854775807", false, &fields)
            .unwrap()
            .next()
            .unwrap()
            .unwrap();
        assert_eq!(valid.get_i64("long").unwrap(), i64::MAX);
    }
}
