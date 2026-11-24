use crate::Result;
use serde::Deserialize;
use std::collections::{HashMap, HashSet};

#[derive(Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct PostgresGridLayout {
    order: Vec<String>,
    hidden: Vec<String>,
    pinned: Vec<String>,
}

pub(super) struct GridColumnPage {
    pub indices: Vec<usize>,
    pub pinned_count: usize,
    pub visible_count: usize,
    pub has_next: bool,
}

impl PostgresGridLayout {
    pub(super) fn page(
        &self,
        columns: &[String],
        page: u32,
        size: usize,
    ) -> Result<GridColumnPage> {
        if [&self.order, &self.hidden, &self.pinned]
            .into_iter()
            .any(|list| {
                list.len() > 1664
                    || list
                        .iter()
                        .any(|name| name.is_empty() || name.len() > 1024 || name.contains('\0'))
            })
        {
            return Err("PostgreSQL 열 설정을 확인하세요.".into());
        }
        let positions: HashMap<_, _> = columns
            .iter()
            .enumerate()
            .map(|(index, name)| (name.as_str(), index))
            .collect();
        let hidden: HashSet<_> = self.hidden.iter().map(String::as_str).collect();
        let mut visited = HashSet::new();
        let mut visible: Vec<_> = self
            .order
            .iter()
            .chain(columns)
            .filter_map(|name| positions.get(name.as_str()).copied())
            .filter(|index| visited.insert(*index) && !hidden.contains(columns[*index].as_str()))
            .collect();
        if visible.is_empty() && !columns.is_empty() {
            visible.push(0);
        }
        let pinned: HashSet<_> = self.pinned.iter().map(String::as_str).collect();
        let fixed: HashSet<_> = visible
            .iter()
            .copied()
            .filter(|index| pinned.contains(columns[*index].as_str()))
            .take(size - 1)
            .collect();
        let mut indices: Vec<_> = visible
            .iter()
            .copied()
            .filter(|index| fixed.contains(index))
            .collect();
        let moving: Vec<_> = visible
            .iter()
            .copied()
            .filter(|index| !fixed.contains(index))
            .collect();
        let page_size = size - indices.len();
        let start = u64::from(page) * page_size as u64;
        if page != 0 && start >= moving.len() as u64 {
            return Err("열 페이지를 다시 선택하세요.".into());
        }
        let start = start as usize;
        let pinned_count = indices.len();
        indices.extend(moving.iter().skip(start).take(page_size));
        Ok(GridColumnPage {
            indices,
            pinned_count,
            visible_count: visible.len(),
            has_next: start + page_size < moving.len(),
        })
    }
}
